"use client";

import DashboardLayout from "@/components/layout/DashboardLayout";
import { useEffect, useState } from "react";
import { doc, getDoc, collection, query, where, getDocs, updateDoc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "@/lib/firebase";
import { stampedBy } from "@/lib/people/changeLog";
import { RequirePermission } from "@/components/auth/RequirePermission";
import { useAuth } from "@/contexts/AuthContext";
import { DAYS, SLOTS, VOLUNTEER_ROLES } from "@/lib/volunteerForm";
import { UserProfile, Badge, EarnedBadge } from "@/lib/types";
import { awardedByLabel, badgeEvents, earnedDay, nextBadge, progressText, ukDate, BadgeCheck } from "@/lib/badges";
import { activityDay, cleanData, courseLengthHours, round1, toDay, volunteerHours, StatsData } from "@/lib/stats";
import { ArrowLeft, Mail, Phone, Clock, Award, CheckCircle, MapPin, Loader2, Pencil, FileText, BookOpen, UserCog, Save, X } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

// Define local interface for Activity if not in types
interface VolunteerActivity {
    id: string;
    volunteerId: string;
    date: string;
    hours: number;
    description: string;
    status: 'approved' | 'pending' | 'rejected';
    location?: string;
    kind: 'class' | 'logged' | 'oneToOne';   // a class they taught, hours logged in the app for other work, or a 1-2-1 session
}

function VolunteerDetailsContent() {
    const searchParams = useSearchParams();
    const uid = searchParams.get("id") as string;

    const [volunteer, setVolunteer] = useState<UserProfile | null>(null);
    const [badges, setBadges] = useState<(Badge & { earned: EarnedBadge; day: string })[]>([]);
    const [nextB, setNextB] = useState<{ badge: Badge; check: BadgeCheck } | null>(null);
    const [activities, setActivities] = useState<VolunteerActivity[]>([]);
    const [loading, setLoading] = useState(true);
    const { user: me } = useAuth();
    const [stats, setStats] = useState({ totalHours: 0, classes: 0, classHours: 0, oneToOneHours: 0, otherHours: 0, pendingHours: 0, classSessions: 0 });
    // Everything else we hold about the person (29 Sep 2026)
    const [courses, setCourses] = useState<{ id: string; code?: string; name?: string; status?: string; day?: string }[]>([]);
    const [managers, setManagers] = useState<{ uid: string; name: string }[]>([]);
    const [oneToOne, setOneToOne] = useState(0);
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState<Record<string, string>>({});
    const [saving, setSaving] = useState(false);
    const [note, setNote] = useState<{ text: string; tone: "ok" | "err" } | null>(null);

    useEffect(() => {
        if (uid) fetchData();
    }, [uid]);

    const fetchData = async () => {
        try {
            // 1. Fetch User Profile
            const userDoc = await getDoc(doc(db, "users", uid));
            if (userDoc.exists()) {
                setVolunteer({ uid: userDoc.id, ...userDoc.data() } as UserProfile);
            }
            // Courses they are assigned to, possible line managers, 1-2-1 sessions
            try {
                const asg = await getDocs(query(collection(db, "courseAssignments"), where("volunteerId", "==", uid)));
                const list = await Promise.all(asg.docs.map(async a => {
                    const c = await getDoc(doc(db, "course", a.data().courseId));
                    const d = c.exists() ? c.data() : {};
                    return { id: a.data().courseId, code: d.code, name: d.name, status: d.status, day: d.schedule?.day || d.day };
                }));
                setCourses(list);
            } catch (e) { console.warn("courses", e); }
            try {
                const m = await getDocs(query(collection(db, "users"), where("role", "in", ["staff", "admin", "super_admin"])));
                setManagers(m.docs.map(d => ({ uid: d.id, name: String(d.data().displayName || d.data().name || d.data().email || d.id) })).sort((a, b) => a.name.localeCompare(b.name)));
            } catch (e) { console.warn("managers", e); }
            let oneToOneRows: any[] = [];
            try {
                const o = await getDocs(query(collection(db, "oneToOneSessions"), where("volunteerId", "==", uid)));
                oneToOneRows = o.docs.map(d => ({ id: d.id, ...d.data() }));
                setOneToOne(o.size);
            } catch { /* not allowed to read */ }

            // 2. Earned Badges (30 Sep 2026): the day it was earned (reachedOn, else earnedAt) and
            // who awarded it by hand. See src/lib/badges.ts.
            const badgeDefsSnap = await getDocs(collection(db, "achievementsBadges"));
            const allBadgeDefs = badgeDefsSnap.docs.map(d => ({ id: d.id, ...d.data() } as Badge));
            const badgeDefs = new Map(allBadgeDefs.map(b => [b.id, b]));
            const earnedSnap = await getDocs(query(collection(db, "earnedAchievements"), where("volunteerId", "==", uid)));
            const earnedIds = new Set<string>();
            const earnedList: (Badge & { earned: EarnedBadge; day: string })[] = [];
            earnedSnap.forEach(d => {
                const e = { id: d.id, ...d.data() } as EarnedBadge;
                const def = badgeDefs.get(e.badgeId);
                if (!def || earnedIds.has(e.badgeId)) return;
                earnedIds.add(e.badgeId);
                earnedList.push({ ...def, earned: e, day: earnedDay(e) });
            });
            earnedList.sort((a, b) => b.day.localeCompare(a.day));
            setBadges(earnedList);

            // 3. Hours (30 Sep 2026): the shared volunteer hours of src/lib/stats.ts, the same rule
            // as the badges. Everything of this person is read: no 100 or 50 limits.
            const activitiesSnap = await getDocs(query(collection(db, "volunteerActivities"), where("volunteerId", "==", uid)));
            const attendanceSnap = await getDocs(query(collection(db, "attendanceRecords"), where("userId", "==", uid)));
            const coursesSnap = await getDocs(collection(db, "course"));
            const allCourses = coursesSnap.docs.map(d => ({ id: d.id, ...d.data() } as any));
            const activityRows = activitiesSnap.docs.map(d => ({ id: d.id, ...d.data() } as any));
            const statsData: StatsData = { courses: allCourses, attendance: attendanceSnap.docs.map(d => d.data()), oneToOne: oneToOneRows, activities: activityRows };
            const h = volunteerHours(uid, statsData);
            setNextB(nextBadge(allBadgeDefs, earnedIds, badgeEvents(uid, statsData)));

            const actList: VolunteerActivity[] = [];
            let pendingHours = 0;

            // Hours logged in the app for work that is not a class (IT support, admin, events…).
            // The app saves the work in `activity`; status starts as pending until approved.
            activityRows.forEach(d => {
                const hrs = Number(d.hours) || 0;
                actList.push({ id: d.id, volunteerId: uid, date: activityDay(d) || "", hours: hrs, description: d.activity || d.description || "Logged hours", status: d.status || "pending", kind: 'logged' });
                if (d.status !== 'approved' && d.status !== 'rejected') pendingHours += hrs;
            });

            // Classes taught: one entry per course per day (a register saved twice counts once).
            const clean = cleanData(statsData);   // registers of deleted courses are left out
            const courseById = clean.courseById;
            const seen = new Set<string>();
            clean.attendance.forEach(att => {
                const key = `${att.courseId}|${att.date}`;
                if (seen.has(key)) return;
                seen.add(key);
                const course: any = courseById.get(att.courseId!);
                actList.push({
                    id: key,
                    volunteerId: uid,
                    date: att.date!,
                    hours: round1(courseLengthHours(course)),
                    description: `Class: ${course?.name || course?.code || "Course"}`,
                    status: 'approved', // a class taught counts as approved
                    location: course?.venue || "",
                    kind: 'class',
                });
            });

            oneToOneRows.forEach(o => {
                actList.push({ id: o.id, volunteerId: uid, date: toDay(o.date) || "", hours: round1((Number(o.durationMinutes) || 0) / 60), description: `1-2-1 session${o.topic ? `: ${o.topic}` : ""}`, status: 'approved', kind: 'oneToOne' });
            });

            // Newest first
            actList.sort((a, b) => String(b.date).localeCompare(String(a.date)));

            setActivities(actList);
            setStats({ totalHours: round1(h.total), classes: h.classes, classHours: round1(h.classHours), oneToOneHours: round1(h.oneToOneHours), otherHours: round1(h.otherHours), pendingHours: round1(pendingHours), classSessions: h.classSessions });

        } catch (error) {
            console.error("Error fetching volunteer details:", error);
        } finally {
            setLoading(false);
        }
    };

    if (loading) {
        return (
            <DashboardLayout>
                <div className="p-8 text-center text-slate-500">Loading details...</div>
            </DashboardLayout>
        );
    }

    if (!volunteer) {
        return (
            <DashboardLayout>
                <div className="p-8 text-center text-red-500">Volunteer not found</div>
            </DashboardLayout>
        );
    }

    const v = volunteer as UserProfile & Record<string, any>;
    const isSuper = me?.role === "super_admin";
    const name: string = v.displayName || v.name || v.email || "";
    const initials = name.trim().split(/\s+/).filter(Boolean).map((w: string) => w[0]).filter(Boolean);
    const avatarText = ((initials[0] || "") + (initials.length > 1 ? initials[initials.length - 1] : "")).toUpperCase() || "?";
    const pic: string = v.profilePicUrl || v.photoURL || "";
    const managerName = managers.find(m => m.uid === v.managerId)?.name || (v.managerId ? "Unknown person" : "");
    const fmtDate = (x: any) => {
        if (!x) return "";
        const d = x.toDate ? x.toDate() : new Date(x);
        return isNaN(d.getTime()) ? String(x) : d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
    };
    const availability: Record<string, string[]> = v.availability || {};
    const hasAvailability = Object.values(availability).some(a => Array.isArray(a) && a.length);
    const extraPerms: string[] = Array.isArray(v.permissions) ? v.permissions : [];

    // Fields shown in the cards above; anything else on the record is listed under "Other information".
    const SHOWN = new Set(["uid", "name", "displayName", "email", "phone", "age", "gender", "profession", "volunteerRole", "dbsCheck", "cvLink",
        "managerId", "ethnicity", "role", "permissions", "createdAt", "createdBy", "hasLoggedInBefore", "leaveAllowance", "applicationId",
        "availability", "profilePicUrl", "photoURL", "chatLastRead", "upgradedAt", "upgradedBy", "totalVolunteerHours"]);
    const others = Object.entries(v).filter(([k, val]) => !SHOWN.has(k) && val !== "" && val !== null && val !== undefined);
    const showVal = (val: any): string => {
        if (val && typeof val === "object" && val.toDate) return fmtDate(val);
        if (Array.isArray(val)) return val.join(", ");
        if (val && typeof val === "object") return Object.entries(val).map(([a, b]) => `${a}: ${typeof b === "object" ? JSON.stringify(b) : b}`).join("; ");
        if (typeof val === "boolean") return val ? "Yes" : "No";
        return String(val);
    };

    const EDIT_FIELDS: { k: string; label: string; type?: "select" | "manager" | "role"; options?: string[] }[] = [
        { k: "name", label: "Name" }, { k: "phone", label: "Phone" }, { k: "age", label: "Age" },
        { k: "gender", label: "Gender", type: "select", options: ["", "Female", "Male"] },
        { k: "profession", label: "Profession" },
        { k: "volunteerRole", label: "Volunteer role", type: "role" },
        { k: "dbsCheck", label: "DBS check" }, { k: "cvLink", label: "CV link (web address)" },
        // Line managers are assigned by a super admin only (System > Line Managers).
        ...(isSuper ? [{ k: "managerId", label: "Line manager", type: "manager" as const }] : []),
    ];
    const startEdit = () => {
        setDraft(Object.fromEntries(EDIT_FIELDS.map(f => [f.k, String(f.k === "name" ? name : (v[f.k] ?? ""))])));
        setEditing(true); setNote(null);
    };
    const save = async () => {
        if (!draft.name?.trim()) { setNote({ text: "The name cannot be empty.", tone: "err" }); return; }
        setSaving(true);
        try {
            const upd: Record<string, any> = {};
            EDIT_FIELDS.forEach(f => { upd[f.k] = (draft[f.k] || "").trim(); });
            upd.displayName = upd.name;
            // Keep the initials picture in step with the name (same rule as the app).
            if (/placehold\.co\/100x100\/22d3ee\/0e7490\?text=/.test(pic) && upd.name !== name) {
                const w = upd.name.split(/\s+/).filter(Boolean);
                const t = ((w[0]?.[0] || "") + (w.length > 1 ? w[w.length - 1][0] : "")).toUpperCase();
                upd.profilePicUrl = "https://placehold.co/100x100/22d3ee/0e7490?text=" + encodeURIComponent(t || "?");
            }
            await updateDoc(doc(db, "users", uid), { ...upd, ...stampedBy(me?.uid || "") });
            setVolunteer({ ...(volunteer as any), ...upd });
            setEditing(false);
            setNote({ text: "Saved. The app shows the new details too.", tone: "ok" });
        } catch (e) { console.error(e); setNote({ text: "Not saved. You may not have permission to change volunteer records.", tone: "err" }); }
        finally { setSaving(false); }
    };
    const openCv = async () => {
        try {
            // 1 Oct 2026: by the volunteer's uid, so the Volunteers permission is enough.
            const res = await httpsCallable(functions, "getVolunteerCvForVolunteer")({ uid });
            const { base64, name: fname } = res.data as { base64: string; name: string };
            const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
            const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
            const w = window.open(url, "_blank");
            if (!w) { const a = document.createElement("a"); a.href = url; a.download = fname || "cv.pdf"; a.click(); }
        } catch (e) {
            console.error(e);
            const m = (e as { message?: string })?.message || "";
            setNote({ text: m && !/^internal$/i.test(m) ? `The CV could not be opened. ${m}` : "The CV from the application could not be opened (the application may have been deleted).", tone: "err" });
        }
    };

    const Row = ({ k, children }: { k: string; children: React.ReactNode }) => (
        <div className="flex justify-between gap-4 py-1.5 border-b border-slate-100 last:border-b-0 text-sm"><span className="text-slate-500 shrink-0">{k}</span><span className="font-medium text-right break-words min-w-0">{children || <span className="text-slate-300">—</span>}</span></div>
    );
    const card = "p-6 rounded-xl shadow-sm border bg-white border-slate-200";
    const inputCls = "w-full p-2 border border-slate-300 rounded-lg text-sm";

    return (
        <DashboardLayout>
            <div className="mb-6">
                <Link href="/admin/volunteers" className="inline-flex items-center gap-2 text-slate-500 hover:text-slate-800 mb-4 transition-colors">
                    <ArrowLeft size={16} /> Back to Volunteers
                </Link>
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="flex items-center gap-4">
                        {pic
                            // eslint-disable-next-line @next/next/no-img-element
                            ? <img src={pic} alt="" className="w-16 h-16 rounded-full object-cover shadow-sm" />
                            : <div className="w-16 h-16 rounded-full flex items-center justify-center text-2xl font-bold text-white shadow-sm" style={{ backgroundColor: '#2c4a00' }}>{avatarText}</div>}
                        <div>
                            <h1 className="text-2xl font-bold text-slate-800">{name}</h1>
                            <div className="flex flex-wrap gap-2 mt-1">
                                <span className="px-3 py-1 bg-slate-100 text-slate-600 rounded-full text-xs font-semibold uppercase">{String(v.role || "").replace(/_/g, " ")}</span>
                                {v.volunteerRole && <span className="px-3 py-1 bg-emerald-50 text-emerald-700 rounded-full text-xs font-semibold">{v.volunteerRole}</span>}
                            </div>
                        </div>
                    </div>
                    {!editing && <button onClick={startEdit} className="self-start md:self-auto px-4 py-2 rounded-lg bg-blue-600 text-white font-semibold text-sm flex items-center gap-2"><Pencil size={14} /> Edit details</button>}
                </div>
            </div>

            {note && (
                <div role={note.tone === "err" ? "alert" : "status"} className={`mb-4 p-3 rounded-lg border text-sm font-medium flex justify-between gap-3 ${note.tone === "ok" ? "bg-green-50 border-green-300 text-green-800" : "bg-red-50 border-red-300 text-red-700"}`}>
                    <span>{note.tone === "ok" ? "✓ " : ""}{note.text}</span><button onClick={() => setNote(null)} aria-label="Close"><X size={16} /></button>
                </div>
            )}

            {editing && (
                <div className={`${card} mb-6 border-blue-300`}>
                    <h3 className="font-bold text-slate-800 mb-4">Edit details</h3>
                    <div className="grid md:grid-cols-2 gap-4">
                        {EDIT_FIELDS.map(f => (
                            <label key={f.k} className="text-xs font-semibold text-slate-600">{f.label}
                                {f.type === "select" ? (
                                    <select className={inputCls} value={draft[f.k] || ""} onChange={e => setDraft({ ...draft, [f.k]: e.target.value })}>{f.options!.map(o => <option key={o} value={o}>{o || "Not given"}</option>)}</select>
                                ) : f.type === "role" ? (
                                    <select className={inputCls} value={draft[f.k] || ""} onChange={e => setDraft({ ...draft, [f.k]: e.target.value })}>
                                        <option value="">Not set</option>
                                        {[...new Set([...VOLUNTEER_ROLES, ...(draft[f.k] ? [draft[f.k]] : [])])].map(o => <option key={o} value={o}>{o}</option>)}
                                    </select>
                                ) : f.type === "manager" ? (
                                    <select className={inputCls} value={draft[f.k] || ""} onChange={e => setDraft({ ...draft, [f.k]: e.target.value })}>
                                        <option value="">No line manager</option>
                                        {managers.filter(m => m.uid !== uid).map(m => <option key={m.uid} value={m.uid}>{m.name}</option>)}
                                    </select>
                                ) : (
                                    <input className={inputCls} value={draft[f.k] || ""} onChange={e => setDraft({ ...draft, [f.k]: e.target.value })} maxLength={f.k === "cvLink" ? 500 : 150} />
                                )}
                            </label>
                        ))}
                    </div>
                    <p className="text-xs text-slate-500 mt-3">The email is their login, so it is not changed here. Role and permissions are changed in Users &amp; Permissions.</p>
                    <div className="flex gap-2 mt-4">
                        <button onClick={save} disabled={saving} className="px-4 py-2 rounded-lg bg-green-600 text-white font-semibold text-sm flex items-center gap-2 disabled:opacity-60"><Save size={14} /> {saving ? "Saving…" : "Save changes"}</button>
                        <button onClick={() => setEditing(false)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm">Cancel</button>
                    </div>
                </div>
            )}

            <div className="grid md:grid-cols-3 gap-6">
                {/* Left column: who they are */}
                <div className="space-y-6">
                    <div className={card}>
                        <h3 className="font-bold text-slate-800 mb-3 uppercase text-xs tracking-wider">Contact</h3>
                        <div className="space-y-3">
                            <a href={`mailto:${v.email}`} className="flex items-center gap-3 text-slate-700 hover:text-blue-700"><Mail size={18} className="text-slate-400 shrink-0" /><span className="text-sm break-all">{v.email}</span></a>
                            {v.phone
                                ? <a href={`tel:${v.phone}`} className="flex items-center gap-3 text-slate-700 hover:text-blue-700"><Phone size={18} className="text-slate-400 shrink-0" /><span className="text-sm">{v.phone}</span></a>
                                : <div className="flex items-center gap-3 text-slate-400"><Phone size={18} className="shrink-0" /><span className="text-sm">No phone number</span></div>}
                        </div>
                    </div>

                    <div className={card}>
                        <h3 className="font-bold text-slate-800 mb-3 uppercase text-xs tracking-wider">Personal details</h3>
                        <Row k="Age">{v.age}</Row>
                        <Row k="Gender">{v.gender}</Row>
                        <Row k="Profession">{v.profession}</Row>
                        <Row k="Volunteer role">{v.volunteerRole}</Row>
                        <Row k="DBS check">{v.dbsCheck && v.dbsCheck !== "N/A" ? v.dbsCheck : ""}</Row>
                        <Row k="Line manager">{managerName}</Row>
                        <Row k="CV">
                            <span className="flex flex-col items-end gap-1">
                                {v.cvLink && /^https?:\/\//.test(v.cvLink) && <a href={v.cvLink} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline">Open CV link</a>}
                                {v.cvLink && !/^https?:\/\//.test(v.cvLink) && <span>{v.cvLink}</span>}
                                {v.applicationId && <button onClick={openCv} className="text-blue-700 hover:underline flex items-center gap-1"><FileText size={13} /> CV from their application</button>}
                            </span>
                        </Row>
                    </div>

                    {v.ethnicity && (
                        <div className={card}>
                            <h3 className="font-bold text-slate-800 mb-3 uppercase text-xs tracking-wider">Private (equality monitoring)</h3>
                            <Row k="Ethnicity">{v.ethnicity}</Row>
                        </div>
                    )}

                    <div className={card}>
                        <h3 className="font-bold text-slate-800 mb-3 uppercase text-xs tracking-wider flex items-center gap-2"><UserCog size={14} /> Account</h3>
                        <Row k="Role">{String(v.role || "").replace(/_/g, " ")}</Row>
                        <Row k="Extra permissions">{extraPerms.length ? extraPerms.join(", ").replace(/_/g, " ") : ""}</Row>
                        <Row k="Has signed in to the app">{v.hasLoggedInBefore ? "Yes" : "Not yet"}</Row>
                        <Row k="Added">{fmtDate(v.createdAt)}</Row>
                        {v.leaveAllowance && <Row k="Annual leave">{`${v.leaveAllowance.remaining} of ${v.leaveAllowance.total} days left (${v.leaveAllowance.year})`}</Row>}
                        {v.applicationId && <Row k="Application"><Link href={`/recruitment/detail?id=${v.applicationId}`} className="text-blue-700 hover:underline">Open their application</Link></Row>}
                    </div>

                    <div className={card}>
                        <h3 className="font-bold text-slate-800 mb-4 uppercase text-xs tracking-wider">Impact Stats</h3>
                        <div className="text-center p-3 bg-amber-50 rounded-lg mb-3"><div className="text-3xl font-bold text-[#7f4c12]">{stats.totalHours}</div><div className="text-[11px] text-slate-600 uppercase mt-1">Volunteer hours</div><div className="text-[11px] text-slate-500">{stats.classes} classes taught, 1-2-1 included</div></div>
                        <div className="grid grid-cols-2 gap-3">
                            <div className="text-center p-3 bg-slate-50 rounded-lg"><div className="text-xl font-bold text-slate-700">{stats.classHours}</div><div className="text-[11px] text-slate-500 uppercase mt-1">Class hours</div><div className="text-[11px] text-slate-400">{stats.classSessions} classes</div></div>
                            <div className="text-center p-3 bg-slate-50 rounded-lg"><div className="text-xl font-bold text-slate-700">{stats.oneToOneHours}</div><div className="text-[11px] text-slate-500 uppercase mt-1">1-2-1 hours</div><div className="text-[11px] text-slate-400">{oneToOne} sessions</div></div>
                            <div className="text-center p-3 bg-slate-50 rounded-lg"><div className="text-xl font-bold text-slate-700">{stats.otherHours}</div><div className="text-[11px] text-slate-500 uppercase mt-1">Other work</div><div className="text-[11px] text-slate-400">approved, logged in the app</div></div>
                            <div className="text-center p-3 bg-slate-50 rounded-lg"><div className="text-xl font-bold text-orange-600">{stats.pendingHours}</div><div className="text-[11px] text-slate-500 uppercase mt-1">Waiting approval</div><div className="text-[11px] text-slate-400">not counted yet</div></div>
                        </div>
                        <p className="text-[11px] text-slate-400 mt-3">A class counts once per course per day, for the length of the course&apos;s timetable (0 when the course has no times). This is the same rule as the badges.</p>
                    </div>
                </div>

                {/* Right column: what they do */}
                <div className="md:col-span-2 space-y-6">
                    <div className={card}>
                        <h3 className="font-bold text-slate-800 mb-3 flex items-center gap-2"><BookOpen className="text-blue-500" size={20} /> Courses</h3>
                        {courses.length === 0 ? <p className="text-sm text-slate-400 italic">Not assigned to a course yet.</p> : (
                            <ul className="divide-y">
                                {courses.map(c => (
                                    <li key={c.id} className="py-2 flex justify-between gap-3 text-sm">
                                        <Link href={`/admin/courses/detail?id=${c.id}`} className="font-medium text-slate-800 hover:text-blue-700">{c.code ? `${c.code} ` : ""}{c.name || "Course"}</Link>
                                        <span className="text-slate-500">{[c.day, c.status].filter(Boolean).join(" · ")}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>

                    <div className={`${card} overflow-x-auto`}>
                        <h3 className="font-bold text-slate-800 mb-3">Weekly availability</h3>
                        {!hasAvailability ? <p className="text-sm text-slate-400 italic">No availability recorded.</p> : (
                            <table className="text-xs w-full min-w-[32rem] table-fixed border-separate" style={{ borderSpacing: "2px" }}>
                                <thead><tr><th className="w-14"></th>{DAYS.map(d => <th key={d} className="p-1 font-semibold text-slate-700">{d.slice(0, 3)}</th>)}</tr></thead>
                                <tbody>
                                    {SLOTS.map(s => (
                                        <tr key={s}><td className="pr-2 text-right text-slate-500 tabular-nums">{s.slice(0, 5)}</td>
                                            {DAYS.map(d => { const on = (availability[d] || []).includes(s); return <td key={d} title={`${d} ${s}: ${on ? "available" : "not available"}`}><div className={`h-5 rounded ${on ? "bg-emerald-500" : "bg-slate-100"}`} /></td>; })}</tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>

                    {/* Badges Section */}
                    <div className={card}>
                        <h3 className="font-bold text-slate-800 mb-4 flex items-center gap-2">
                            <Award className="text-yellow-500" size={20} /> Achievements
                        </h3>
                        {nextB && (
                            <div className="mb-4 p-3 rounded-lg border border-purple-100 bg-purple-50">
                                <p className="text-[11px] font-bold text-purple-700 uppercase">Next badge</p>
                                <p className="text-sm font-semibold text-slate-800">{nextB.badge.name}</p>
                                <div className="w-full bg-white rounded-full h-2 mt-1">
                                    <div className="bg-purple-600 h-2 rounded-full" style={{ width: `${Math.min(100, Math.floor((nextB.check.current / nextB.check.goal) * 100))}%` }} />
                                </div>
                                <p className="text-xs text-slate-600 mt-1">{nextB.check.reached ? "Target reached. The badge will be added at the next check." : progressText(nextB.check)}</p>
                            </div>
                        )}
                        {badges.length === 0 ? (
                            <p className="text-sm text-slate-400 italic">No badges earned yet.</p>
                        ) : (
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                                {badges.map(badge => (
                                    <div key={badge.id} className="p-3 border rounded-lg flex flex-col items-center text-center bg-slate-50" title={badge.earned.reason || badge.description || ""}>
                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                        <img src={badge.iconUrl || "https://placehold.co/100x100?text=B"} alt={badge.name} className="w-10 h-10 mb-2 rounded-full" />
                                        <div className="font-bold text-xs text-slate-800">{badge.name}</div>
                                        <div className="text-[10px] text-slate-500">{ukDate(badge.day)}</div>
                                        {awardedByLabel(badge.earned) && <div className="text-[10px] text-slate-500">{awardedByLabel(badge.earned)}</div>}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Activity Log */}
                    <div className={card}>
                        <h3 className="font-bold text-slate-800 mb-4 flex items-center gap-2">
                            <Clock className="text-slate-400" size={20} /> Recent Activity
                        </h3>
                        <div className="space-y-4">
                            {activities.length === 0 ? (
                                <p className="text-sm text-slate-400 italic">No recent activity recorded.</p>
                            ) : (
                                activities.map(activity => (
                                    <div key={activity.id} className="flex items-start gap-4 p-3 hover:bg-slate-50 rounded-lg transition-colors border border-transparent hover:border-slate-100">
                                        <div className={`mt-1 p-1.5 rounded-full ${activity.status === 'approved' ? 'bg-green-100 text-green-600' : 'bg-orange-100 text-orange-600'}`}>
                                            {activity.status === 'approved' ? <CheckCircle size={14} /> : <Clock size={14} />}
                                        </div>
                                        <div className="flex-1">
                                            <div className="flex justify-between">
                                                <h4 className="font-medium text-slate-800 text-sm">{activity.description || "Volunteer Session"}</h4>
                                                <span className="text-xs text-slate-400">{activity.date}</span>
                                            </div>
                                            <div className="flex items-center gap-4 mt-1">
                                                <span className="text-xs text-slate-500 flex items-center gap-1"><Clock size={12} /> {activity.hours} hrs</span>
                                                {activity.location && <span className="text-xs text-slate-500 flex items-center gap-1"><MapPin size={12} /> {activity.location}</span>}
                                                <span className={`text-[11px] px-2 py-0.5 rounded-full ${activity.kind === 'class' ? "bg-blue-50 text-blue-700" : activity.kind === 'oneToOne' ? "bg-teal-50 text-teal-700" : "bg-purple-50 text-purple-700"}`}>{activity.kind === 'class' ? "Class" : activity.kind === 'oneToOne' ? "1-2-1" : "Other work"}</span>
                                                {activity.status !== 'approved' && <span className={`text-xs font-semibold ${activity.status === 'rejected' ? "text-red-600" : "text-orange-600"}`}>{activity.status === 'rejected' ? "Rejected" : "Waiting approval"}</span>}
                                            </div>
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>

                    {others.length > 0 && (
                        <div className={card}>
                            <h3 className="font-bold text-slate-800 mb-3">Other information on their record</h3>
                            {others.map(([k, val]) => <Row key={k} k={k.replace(/([A-Z])/g, " $1").replace(/^./, c => c.toUpperCase())}>{showVal(val)}</Row>)}
                        </div>
                    )}
                </div>
            </div>
        </DashboardLayout>
    );
}

export default function VolunteerDetailsPage() {
    return (
        <RequirePermission perm="volunteers">
            <Suspense fallback={<DashboardLayout><div className="flex justify-center items-center h-64"><Loader2 className="animate-spin text-slate-400 w-8 h-8" /></div></DashboardLayout>}>
                <VolunteerDetailsContent />
            </Suspense>
        </RequirePermission>
    );
}
