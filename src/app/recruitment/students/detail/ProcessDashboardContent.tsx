"use client";

import DashboardLayout from "@/components/layout/DashboardLayout";
import { extraAnswerRows, SubmissionLabels } from "@/lib/formTemplates";
import { CheckCircle, ExternalLink, PenTool, X, ArrowLeft, Archive, RotateCcw, Download, Search } from "lucide-react";
import React, { useState, useEffect } from "react";
import { collection, onSnapshot, doc, getDoc, updateDoc, getDocs, addDoc, where, query, writeBatch, Timestamp, serverTimestamp } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db as mainDb, functions } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";
import { publicFormUrl, submissionsPath } from "@/lib/applicationForms";
import { DEFAULT_TEMPLATES, STUDENT_FORM_IDS } from "@/lib/formTemplates";
import { APP_STATUSES, AppStatus, STATUS_STYLE, appStatusOf, endOfLondonDay, isOldDatabase, processState, ukShortDate, whenMs } from "@/lib/studentApplications";
import { saveStudentPrivate, mainStudentData, loadStudentPrivateMap, overlayPrivate, pickPrivate } from "@/lib/studentPrivate";
import { applicantName, fillEmpty, findStudentMatches, normDob, StudentMatch } from "@/lib/students/matching";
import { db as refugeesDb } from "@/lib/firebase-refugees";
import { transliterate } from "transliteration";
import { useSearchParams, useRouter } from "next/navigation";
import { ApplicationProcess, Course } from "@/lib/types";
import Link from "next/link";

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

// The forms store the country name ("Syria"); some old forms stored a two letter code ("SY").
function getCountryName(code: string | undefined): string {
    const v = String(code ?? "").trim();
    if (!v) return 'Unknown';
    if (!/^[A-Za-z]{2}$/.test(v)) return v;
    try {
        return regionNames.of(v.toUpperCase()) || v;
    } catch (e) {
        return v;
    }
}

/** The nationality the applicant gave (the forms save it as `nationality`), or "". */
function nationalityOf(app: Record<string, any>): string {
    const v = app.nationality ?? app.answers?.nationality ?? app.Nationality ?? app.country;
    return typeof v === "string" ? v.trim() : "";
}


// Helper: calculate age from DOB string
function calcAge(dob: string | undefined): number {
    if (!dob) return 0;
    const birth = new Date(dob);
    if (isNaN(birth.getTime())) return 0;
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const m = today.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
    return age;
}

// Friendly labels for known application field keys
const FIELD_LABELS: Record<string, string> = {
    name: "Full Name",
    firstName: "First Name",
    lastName: "Last Name",
    email: "Email",
    mobile: "Mobile",
    nationality: "Nationality",
    postcode: "Postcode",
    dob: "Date of Birth",
    age: "Age",
    itLevel: "IT Level",
    languageUsed: "Language Used",
    status: "Status",
    submittedAt: "Submitted At",
    refugeeNumber: "Refugee Number",
    programme: "Programme",
    yearClass: "Year / Class",
    gender: "Gender",
    school: "Current School",
    parentName: "Parent / Guardian",
    parentPhone: "Parent / Guardian Phone",
    address: "Address",
    emergencyContactName: "Emergency Contact Name",
    emergencyContactPhone: "Emergency Contact Phone",
    emergencyContact: "Emergency Contact",
};

// Fields to hide in the detail modal (internal/redundant)
const HIDDEN_FIELDS = new Set(["id", "__path__", "processId", "formType", "consent", "answers", "labels", "studentId",
    "decidedBy", "declineEmailBy", "importedFrom", "importedAt", "importedBy", "oldStatus"]);

interface Application {
    id: string;
    firstName?: string;
    lastName?: string;
    name?: string;
    email?: string;
    status?: string;
    nationality?: string;
    postcode?: string;
    age?: string | number;
    dob?: string;
    mobile?: string;
    itLevel?: string;
    languageUsed?: string;
    submittedAt?: any;
    [key: string]: any;
}

const FORM_LABEL = (f?: string) => (f && (DEFAULT_TEMPLATES as Record<string, { name: string }>)[f]?.name) || "";
const isOwnDecision = (s: AppStatus) => s === "Waiting list" || s === "Declined";

/** A copy of an old-database application, ready for the portal (no undefined values; dates as Timestamps). */
function portalCopy(raw: Record<string, unknown>, collectionName: string, procId: string, formType: string, by: string) {
    const clean = (v: unknown): unknown => {
        if (v === undefined) return null;
        if (v instanceof Timestamp) return v;
        if (v && typeof (v as { toDate?: () => Date }).toDate === "function") return Timestamp.fromDate((v as { toDate: () => Date }).toDate());
        if (Array.isArray(v)) return v.map(clean);
        if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).map(([k, x]) => [k, clean(x)]));
        return v;
    };
    const out = clean(raw) as Record<string, unknown>;
    const ms = whenMs(raw.submittedAt) || whenMs(raw.createdAt) || whenMs(raw.timestamp);
    out.submittedAt = ms ? Timestamp.fromMillis(ms) : Timestamp.now();
    if (!ms) out.submittedAtUnknown = true;
    out.oldStatus = raw.status ?? null;
    out.status = appStatusOf(raw.status);
    out.processId = procId;
    if (formType) out.formType = formType;
    out.importedFrom = `refugees-appform/${collectionName}`;
    out.importedAt = serverTimestamp();
    out.importedBy = by;
    return out;
}

export function ProcessDashboardContent() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const { user } = useAuth();
    const isSuper = user?.role === "super_admin";
    const processId = searchParams.get("id") as string;
    const openAppId = searchParams.get("app");

    const [processInfo, setProcessInfo] = useState<ApplicationProcess | null>(null);
    const [applications, setApplications] = useState<Application[]>([]);
    const [courses, setCourses] = useState<Course[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadFailed, setLoadFailed] = useState(false);
    const [filter, setFilter] = useState<"all" | AppStatus>("all");
    const [search, setSearch] = useState("");

    const [busyId, setBusyId] = useState<string | null>(null);
    const [declineFor, setDeclineFor] = useState<Application | null>(null);
    const [declineEmail, setDeclineEmail] = useState(true);
    // Accept: possible existing students for this applicant (1 Oct 2026).
    const [dupCheck, setDupCheck] = useState<{ app: Application; matches: StudentMatch[]; dobChecked: boolean } | null>(null);
    const [dupBusy, setDupBusy] = useState(false);
    const [detailApp, setDetailApp] = useState<Application | null>(null);
    // Edit
    const [editOpen, setEditOpen] = useState(false);
    const [edit, setEdit] = useState({ title: "", description: "", opensOn: "", closesOn: "", courseId: "" });
    const [saving, setSaving] = useState(false);
    // Move from the old database
    const [moveForm, setMoveForm] = useState<string>("");
    const [moveLog, setMoveLog] = useState<string[]>([]);
    const [moving, setMoving] = useState(false);

    useEffect(() => {
        if (!processId) return;
        let unsubscribe: (() => void) | null = null;
        (async () => {
            try {
                const procDoc = await getDoc(doc(mainDb, "applicationProcesses", processId));
                if (!procDoc.exists()) { alert("Application process not found."); router.push("/recruitment/students"); return; }
                const data = { id: procDoc.id, ...procDoc.data() } as ApplicationProcess;
                setProcessInfo(data);
                const t = String(data.title || "").toLowerCase();
                setMoveForm(data.formType || (t.includes("referral") ? "referral" : t.includes("refugee") ? "refugees" : ""));
                const cSnap = await getDocs(collection(mainDb, "course"));
                setCourses(cSnap.docs.map(d => ({ id: d.id, ...d.data() } as Course)).sort((a, b) => (a.code || "").localeCompare(b.code || "")));
                // Every application, live, newest first (no limit since 6 Oct 2026).
                const activeDb = isOldDatabase(data) ? refugeesDb : mainDb;
                unsubscribe = onSnapshot(collection(activeDb, data.collectionName || submissionsPath(processId)), (snapshot) => {
                    const apps = snapshot.docs.map(d => ({ id: d.id, ...d.data() } as Application))
                        .sort((a, b) => whenMs(b.submittedAt) - whenMs(a.submittedAt));
                    setApplications(apps);
                    setLoading(false);
                }, (error) => { console.error("Error fetching applications:", error); setLoadFailed(true); setLoading(false); });
            } catch (err) {
                console.error("Failed to load process info", err);
                setLoadFailed(true);
                setLoading(false);
            }
        })();
        return () => { if (unsubscribe) unsubscribe(); };
    }, [processId, router]);

    // Keep an open applicant window in step with the live list (its status changes after a decision).
    useEffect(() => {
        setDetailApp(prev => prev ? (applications.find(x => x.id === prev.id) || prev) : prev);
    }, [applications]);

    // Opened from "All applications": show that applicant straight away.
    useEffect(() => {
        if (!openAppId || detailApp) return;
        const a = applications.find(x => x.id === openAppId);
        if (a) setDetailApp(a);
    }, [openAppId, applications, detailApp]);

    const state = processInfo ? processState(processInfo) : "closed";
    const archived = state === "archived";
    const oldDb = !!processInfo && isOldDatabase(processInfo);
    const appRef = (id: string) => doc(oldDb ? refugeesDb : mainDb, processInfo!.collectionName || submissionsPath(processId), id);
    const stamp = () => ({ decidedAt: new Date().toISOString(), decidedBy: user?.uid || "" });

    const setOpen = async (open: boolean) => {
        if (!processInfo) return;
        const msg = open ? "Reopen this process? The form link will accept applications again." : "Close this process? The form link stops working straight away. You can reopen it later.";
        if (!confirm(msg)) return;
        try {
            await updateDoc(doc(mainDb, "applicationProcesses", processId), { status: open ? "Open" : "Closed" });
            setProcessInfo({ ...processInfo, status: open ? "Open" : "Closed" });
        } catch (e) { console.error(e); alert("Not changed. You may not have permission."); }
    };

    const archiveProcess = async () => {
        if (!processInfo) return;
        const typed = prompt(`Archive "${processInfo.title}"?\n\nIt leaves the Processes list and its link stops working. Its ${applications.length} application(s) are KEPT, read only, under Archived, and students already accepted stay students. You can restore it later.\n\nType ARCHIVE to confirm.`);
        if ((typed || "").trim().toUpperCase() !== "ARCHIVE") return;
        try {
            const upd = { archived: true, status: "Closed" as const, archivedAt: new Date().toISOString(), archivedBy: user?.uid || "", archivedByName: user?.displayName || "" };
            await updateDoc(doc(mainDb, "applicationProcesses", processId), upd);
            setProcessInfo({ ...processInfo, ...upd });
        } catch (e) { console.error(e); alert("Not archived. Only the super admin can archive a process."); }
    };
    const restoreProcess = async () => {
        if (!processInfo || !confirm("Restore this process? It goes back to the Processes list, closed.")) return;
        try {
            await updateDoc(doc(mainDb, "applicationProcesses", processId), { archived: false, status: "Closed" });
            setProcessInfo({ ...processInfo, archived: false, status: "Closed" });
        } catch (e) { console.error(e); alert("Not restored. Only the super admin can restore a process."); }
    };

    const openEdit = () => {
        if (!processInfo) return;
        setEdit({ title: processInfo.title || "", description: processInfo.description || "", opensOn: processInfo.opensOn || "", closesOn: processInfo.closesOn || "", courseId: processInfo.courseId || "" });
        setEditOpen(true);
    };
    const saveEdit = async () => {
        if (!processInfo) return;
        if (!edit.title.trim()) { alert("The process needs a name."); return; }
        if (edit.opensOn && edit.closesOn && edit.closesOn < edit.opensOn) { alert("The closing date is before the opening date."); return; }
        setSaving(true);
        try {
            const upd: Record<string, unknown> = {
                title: edit.title.trim(), description: edit.description.trim(), courseId: edit.courseId,
                opensOn: edit.opensOn || "", closesOn: edit.closesOn || "", closesAt: edit.closesOn ? endOfLondonDay(edit.closesOn) : null,
            };
            await updateDoc(doc(mainDb, "applicationProcesses", processId), upd);
            setProcessInfo({ ...processInfo, ...upd } as ApplicationProcess);
            setEditOpen(false);
        } catch (e) { console.error(e); alert("Not saved. You may not have permission."); }
        finally { setSaving(false); }
    };

    /** The student fields an application gives, and its extra answers ("question: answer"). */
    const studentDataFromApp = (app: Application) => {
        const rawFullName = applicantName(app) || 'Unknown Applicant';
        const { id, firstName, lastName, name, email, status, nationality, postcode, age, dob, mobile, itLevel, languageUsed, submittedAt, __path__,
            processId: _pid, formType: _ft, consent: _consent, answers: _answers, labels: _labels, studentId: _sid,
            decidedAt: _da, decidedBy: _db, declineEmailAt: _dea, declineEmailBy: _deb, importedFrom: _if, importedAt: _ia, importedBy: _ib, oldStatus: _os, submittedAtUnknown: _su,
            ...rest } = app as Application & { answers?: Record<string, unknown>; labels?: SubmissionLabels };
        void id; void firstName; void lastName; void name; void status; void submittedAt; void __path__; void _pid; void _ft; void _consent; void _sid;
        void _da; void _db; void _dea; void _deb; void _if; void _ia; void _ib; void _os; void _su;
        const applicationAnswers: Record<string, string> = Object.fromEntries(extraAnswerRows(_answers, _labels).map(r => [r.label, r.value]));
        const data: Record<string, any> = {
            name: rawFullName,
            email: email || "",
            nationality: nationality || "",
            postcode: postcode || "",
            // The referral form asks the age, the others the date of birth (6 Oct 2026).
            age: dob ? calcAge(dob) : (Number(age) || 0),
            dob: dob || "",
            mobile: mobile || "",
            itLevel: itLevel || "",
            languageUsed: languageUsed || "",
            applicationId: app.id,
            ...rest,
        };
        return { name: rawFullName, data, applicationAnswers };
    };

    const markAccepted = async (app: Application, studentId: string) => {
        try { await updateDoc(appRef(app.id), { status: "Accepted", studentId, ...stamp() }); }
        catch (err) {
            // The old database may not accept the extra fields: the status is what matters.
            console.warn("studentId not saved on the application", err);
            await updateDoc(appRef(app.id), { status: "Accepted" });
        }
    };

    const loadStudentsForMatching = async () => {
        const [snap, privMap] = await Promise.all([getDocs(collection(mainDb, "students")), loadStudentPrivateMap()]);
        const list = snap.docs.map(d => ({ id: d.id, ...overlayPrivate(d.data(), privMap?.get(d.id)) } as Record<string, any> & { id: string }));
        return { list, privMap };
    };

    const createStudentFromApp = async (app: Application) => {
        if (!processInfo?.courseId) return;
        const { name, data, applicationAnswers } = studentDataFromApp(app);
        const studentData: Record<string, any> = { ...data, createdAt: new Date().toISOString(), ...(Object.keys(applicationAnswers).length ? { applicationAnswers } : {}) };
        const studentRef = await addDoc(collection(mainDb, "students"), mainStudentData(studentData));
        await saveStudentPrivate(studentRef.id, studentData);
        await addDoc(collection(mainDb, "courseRoster"), { courseId: processInfo.courseId, studentId: studentRef.id, role: "student", enrolledAt: new Date().toISOString() });
        await markAccepted(app, studentRef.id);
        alert(`${name} is now a student and enrolled on the course.`);
    };

    const handleAccept = async (app: Application) => {
        if (!processInfo) return;
        if (!processInfo.courseId) { alert("This process is not linked to a course yet. Press Edit and choose the course first."); return; }
        setBusyId(app.id);
        try {
            const { list, privMap } = await loadStudentsForMatching();
            const matches = findStudentMatches(app, list);
            if (matches.length) { setDupCheck({ app, matches, dobChecked: privMap !== null }); return; }
            if (!confirm(`Accept ${applicantName(app) || "this applicant"}? They will become a student and be enrolled on the course.`)) return;
            await createStudentFromApp(app);
        } catch (err) { console.error("Error accepting applicant:", err); alert("An error occurred during acceptance."); }
        finally { setBusyId(null); }
    };

    const handleCreateAnyway = async () => {
        if (!dupCheck) return;
        setDupBusy(true);
        try { await createStudentFromApp(dupCheck.app); setDupCheck(null); }
        catch (err) { console.error("Error accepting applicant:", err); alert("An error occurred during acceptance."); }
        finally { setDupBusy(false); }
    };

    /** Use the existing student: enrol them, fill their empty fields from the application, keep the answers. */
    const handleUseExisting = async (match: StudentMatch) => {
        if (!dupCheck || !processInfo?.courseId) return;
        const app = dupCheck.app;
        const sid = match.student.id;
        setDupBusy(true);
        try {
            const { name, data, applicationAnswers } = studentDataFromApp(app);
            const existing = match.student;
            const ALLOWED = ['name', 'email', 'postcode', 'age', 'mobile', 'itLevel', 'languageUsed', 'applicationId', 'programme', 'yearClass', 'gender', 'school', 'parentName', 'parentPhone', 'address', 'emergencyContactName', 'emergencyContactPhone', 'emergencyContact'];
            const filled: Record<string, any> = fillEmpty(existing, mainStudentData(data));
            const update: Record<string, any> = {};
            Object.keys(filled).forEach(k => { if (ALLOWED.includes(k)) update[k] = filled[k]; });
            if (Object.keys(applicationAnswers).length) {
                const before = existing.applicationAnswers && typeof existing.applicationAnswers === "object" ? existing.applicationAnswers : {};
                update.applicationAnswers = { ...before, ...applicationAnswers };
            }
            if (Object.keys(update).length) {
                try { await updateDoc(doc(mainDb, "students", sid), update); }
                catch (err) {
                    console.error("Existing student not updated", err);
                    alert("The existing student could not be updated. You need the Students permission to change a student record. Nothing was changed.");
                    return;
                }
            }
            if (dupCheck.dobChecked) {
                const privFill = fillEmpty(existing, pickPrivate(data));
                if (privFill.dob) privFill.dob = normDob(privFill.dob) || privFill.dob;
                if (Object.keys(privFill).length) await saveStudentPrivate(sid, privFill);
            }
            const onCourse = await getDocs(query(collection(mainDb, "courseRoster"), where("studentId", "==", sid), where("courseId", "==", processInfo.courseId)));
            if (onCourse.empty) await addDoc(collection(mainDb, "courseRoster"), { courseId: processInfo.courseId, studentId: sid, role: "student", enrolledAt: new Date().toISOString() });
            await markAccepted(app, sid);
            setDupCheck(null);
            alert(onCourse.empty
                ? `${existing.name || name} is enrolled on the course, using their existing student record.`
                : `${existing.name || name} was already on this course. The application is marked accepted and linked to their record.`);
        } catch (err) { console.error("Error using existing student:", err); alert("An error occurred. Please check the student's page before trying again."); }
        finally { setDupBusy(false); }
    };

    const setStatus = async (app: Application, status: AppStatus) => {
        setBusyId(app.id);
        try { await updateDoc(appRef(app.id), { status, ...stamp() }); }
        catch (e) { console.error(e); alert("Not changed. You may not have permission."); }
        finally { setBusyId(null); }
    };

    const contactEmail = (a: Application) => {
        const ans = (a.answers && typeof a.answers === "object") ? a.answers as Record<string, unknown> : {};
        const e = String((a.formType === "referral" ? ans.referrerEmail : a.email) || "").trim();
        return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : "";
    };

    const confirmDecline = async () => {
        const app = declineFor;
        if (!app) return;
        setBusyId(app.id);
        try {
            await updateDoc(appRef(app.id), { status: "Declined", ...stamp() });
            if (declineEmail && contactEmail(app) && !oldDb) {
                try {
                    const r = await httpsCallable(functions, "studentDeclineEmail")({ processId, submissionId: app.id });
                    const d = r.data as { sent?: boolean; already?: boolean };
                    if (d.already) alert("Declined. The polite email had already been sent before.");
                } catch (e) { console.error(e); alert("Declined, but the email could not be sent: " + ((e as Error).message || "unknown error")); }
            }
            setDeclineFor(null);
        } catch (e) { console.error(e); alert("Not changed. You may not have permission."); }
        finally { setBusyId(null); }
    };

    /** Super admin: copy every application from the old database into the portal, then switch the process over. */
    const moveIntoPortal = async () => {
        if (!processInfo || !oldDb) return;
        const coll = processInfo.collectionName || "applications";
        if (!confirm(`Move "${processInfo.title}" into the portal?\n\n1. A backup file of all ${applications.length} application(s) is downloaded to your computer first.\n2. Every application is copied into the portal (the old copy is not changed).\n3. The process then reads from the portal${moveForm ? ` and uses the portal's "${FORM_LABEL(moveForm)}" form` : ""}.\n\nNobody is emailed.`)) return;
        setMoving(true);
        const log = (m: string) => setMoveLog(prev => [...prev, m]);
        try {
            // 1. Backup
            const snap = await getDocs(collection(refugeesDb, coll));
            const backup = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            const blob = new Blob([JSON.stringify({ project: "refugees-appform", collection: coll, process: processInfo.title, at: new Date().toISOString(), count: backup.length, docs: backup }, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url; a.download = `backup-${coll}-${new Date().toISOString().slice(0, 10)}.json`; a.click();
            setTimeout(() => URL.revokeObjectURL(url), 2000);
            log(`Backup downloaded: ${backup.length} application(s) from ${coll}.`);
            // 2. Copy (same ids, so running it again never duplicates)
            const target = submissionsPath(processId);
            for (let i = 0; i < snap.docs.length; i += 400) {
                const batch = writeBatch(mainDb);
                snap.docs.slice(i, i + 400).forEach(d => batch.set(doc(mainDb, target, d.id), portalCopy(d.data(), coll, processId, moveForm, user?.uid || "")));
                await batch.commit();
                log(`Copied ${Math.min(i + 400, snap.docs.length)} of ${snap.docs.length}.`);
            }
            const check = await getDocs(collection(mainDb, target));
            const missing = snap.docs.filter(d => !check.docs.some(c => c.id === d.id)).length;
            if (missing) { log(`STOPPED: ${missing} application(s) are missing in the portal. Nothing was switched over.`); return; }
            log(`Checked: all ${snap.docs.length} are in the portal.`);
            // 3. Switch the process over
            const upd: Record<string, unknown> = {
                sourceProject: "main", collectionName: target,
                movedFrom: { project: "refugees-appform", collection: coll, count: snap.docs.length, at: new Date().toISOString(), by: user?.uid || "" },
            };
            if (moveForm) { upd.formType = moveForm; upd.externalLink = publicFormUrl(processId); } else { upd.formType = ""; upd.externalLink = ""; }
            await updateDoc(doc(mainDb, "applicationProcesses", processId), upd);
            log("Done. This process now lives in the portal. Reloading…");
            setTimeout(() => window.location.reload(), 1500);
        } catch (e) {
            console.error(e);
            log("Error: " + ((e as Error).message || String(e)) + ". Nothing was deleted; you can press the button again.");
        } finally { setMoving(false); }
    };

    if (loading && !processInfo) {
        return <DashboardLayout><div className="flex justify-center items-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div></div></DashboardLayout>;
    }
    if (!processInfo) return null;

    const counts: Record<AppStatus, number> = { "New": 0, "Waiting list": 0, "Accepted": 0, "Declined": 0 };
    applications.forEach(a => { counts[appStatusOf(a.status)]++; });
    const shown = applications.filter(a => {
        if (filter !== "all" && appStatusOf(a.status) !== filter) return false;
        const q = search.trim().toLowerCase();
        if (!q) return true;
        return [applicantName(a), a.email, a.mobile, a.postcode, a.parentName].map(v => String(v || "").toLowerCase()).join(" ").includes(q);
    });

    const withNationality = applications.filter(a => nationalityOf(a));
    const nationalityCounts = withNationality.reduce((acc: Record<string, number>, app) => { const n = getCountryName(nationalityOf(app)); acc[n] = (acc[n] || 0) + 1; return acc; }, {});
    const topNationalities = Object.entries(nationalityCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const linkedCourse = courses.find(c => c.id === processInfo.courseId);

    const formatFieldValue = (key: string, value: any): string => {
        if (value === null || value === undefined || value === "") return "—";
        if (key === "nationality") return getCountryName(value);
        if (key === "submittedAt" || key === "decidedAt" || key === "declineEmailAt") {
            const ms = whenMs(value);
            if (ms) { const d = new Date(ms); return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) + ' at ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
            return String(value);
        }
        if (Array.isArray(value)) return value.join(", ");
        if (typeof value === "object") return JSON.stringify(value);
        if (key === "itLevel") return String(value).charAt(0).toUpperCase() + String(value).slice(1);
        return String(value);
    };

    const actions = (app: Application) => {
        const st = appStatusOf(app.status);
        if (archived) return null;
        const b = "px-3 py-1.5 text-xs font-bold rounded shadow-sm transition whitespace-nowrap border disabled:opacity-50";
        const busy = busyId === app.id;
        return (
            <div className="flex flex-wrap items-center gap-2 justify-end">
                {st !== "Accepted" && <button disabled={busy || !processInfo.courseId} onClick={() => handleAccept(app)} className={`${b} bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700`} title={processInfo.courseId ? "" : "Link a course first (Edit)"}>{busy ? "Working…" : "Accept"}</button>}
                {(st === "New" || st === "Declined") && <button disabled={busy} onClick={() => setStatus(app, "Waiting list")} className={`${b} bg-white text-amber-800 border-amber-300 hover:bg-amber-50`}>Waiting list</button>}
                {(st === "New" || st === "Waiting list") && <button disabled={busy} onClick={() => { setDeclineFor(app); setDeclineEmail(!!contactEmail(app) && !oldDb); }} className={`${b} bg-white text-rose-600 border-rose-300 hover:bg-rose-50`}>Decline</button>}
                {isOwnDecision(st) && <button disabled={busy} onClick={() => setStatus(app, "New")} className={`${b} bg-white text-slate-600 border-slate-300 hover:bg-slate-50`} title="Undo the decision">Back to New</button>}
            </div>
        );
    };

    const headBtn = "bg-white border border-slate-300 text-slate-700 px-3 py-2 rounded-lg font-bold hover:bg-slate-50 transition shadow-sm text-sm flex items-center gap-1";
    return (
        <DashboardLayout>
            <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
                <div>
                    <Link href="/recruitment/students" className="text-blue-600 hover:underline flex items-center gap-1 text-sm font-semibold mb-2"><ArrowLeft size={16} /> Student Applications</Link>
                    <div className="flex items-center gap-3 flex-wrap">
                        <h1 className="text-2xl font-bold text-slate-800">{processInfo.title}</h1>
                        <span className={`px-2 py-1 text-xs font-bold rounded-full border ${state === "open" ? 'bg-blue-50 text-blue-700 border-blue-200' : state === "upcoming" ? 'bg-amber-50 text-amber-800 border-amber-200' : 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                            {state === "open" ? "Open" : state === "upcoming" ? "Not open yet" : state === "archived" ? "Archived" : "Closed"}
                        </span>
                    </div>
                    {processInfo.description && <p className="text-slate-500 mt-1">{processInfo.description}</p>}
                    <p className="text-xs text-slate-500 mt-1">
                        {[FORM_LABEL(processInfo.formType) ? `${FORM_LABEL(processInfo.formType)} form` : "", processInfo.opensOn ? `Opens ${ukShortDate(processInfo.opensOn)}` : "", processInfo.closesOn ? `Closes ${ukShortDate(processInfo.closesOn)} (the link stops working after that day)` : "No closing date"].filter(Boolean).join(" · ")}
                    </p>
                </div>
                <div className="flex gap-2 flex-wrap">
                    {!archived && processInfo.status === "Open" && <button onClick={() => setOpen(false)} className={headBtn}>Close</button>}
                    {!archived && processInfo.status !== "Open" && <button onClick={() => setOpen(true)} className={headBtn}>Reopen</button>}
                    {!archived && <button onClick={openEdit} className="bg-purple-600 text-white px-3 py-2 rounded-lg font-bold hover:bg-purple-700 transition shadow-sm text-sm flex items-center gap-1"><PenTool size={16} /> Edit</button>}
                    {isSuper && !archived && <button onClick={archiveProcess} className={`${headBtn} text-rose-700 border-rose-300`}><Archive size={16} /> Archive</button>}
                    {isSuper && archived && <button onClick={restoreProcess} className={headBtn}><RotateCcw size={16} /> Restore</button>}
                </div>
            </div>

            <div className="max-w-6xl mx-auto space-y-6">
                {archived && <div className="p-4 rounded-xl border border-slate-300 bg-slate-100 text-slate-700 text-sm">This process is archived{processInfo.archivedByName ? ` (by ${processInfo.archivedByName}${processInfo.archivedAt ? `, ${ukShortDate(processInfo.archivedAt.slice(0, 10))}` : ""})` : ""}. Its applications are kept here, read only.</div>}

                {oldDb && (
                    <div className="p-5 rounded-xl border border-amber-300 bg-amber-50 text-sm text-amber-900 space-y-3">
                        <p className="font-bold">This process still reads the old forms database (refugees-appform, &quot;{processInfo.collectionName}&quot;).</p>
                        <p>That database is open to anyone on the internet, so these applications should be moved into the portal and the old site switched off.</p>
                        {isSuper ? (
                            <>
                                <label className="block"><span className="font-semibold">Portal form to use from now on: </span>
                                    <select className="ml-2 p-1.5 border rounded bg-white" value={moveForm} onChange={e => setMoveForm(e.target.value)} disabled={moving}>
                                        <option value="">None (keep it closed, applications only)</option>
                                        {STUDENT_FORM_IDS.map(id => <option key={id} value={id}>{DEFAULT_TEMPLATES[id].name}</option>)}
                                    </select>
                                </label>
                                <button onClick={moveIntoPortal} disabled={moving || loading} className="px-4 py-2 rounded-lg bg-amber-600 text-white font-bold hover:bg-amber-700 disabled:opacity-50 flex items-center gap-2"><Download size={16} /> {moving ? "Moving…" : `Back up and move ${applications.length} application(s) into the portal`}</button>
                                {moveLog.length > 0 && <ul className="list-disc ml-5 space-y-0.5">{moveLog.map((m, i) => <li key={i}>{m}</li>)}</ul>}
                            </>
                        ) : <p>The super admin can move it.</p>}
                    </div>
                )}

                <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 flex items-center justify-between gap-4 flex-wrap">
                    <div>
                        <p className="text-sm text-slate-500 font-semibold uppercase">Course accepted applicants join</p>
                        <p className="font-bold text-slate-800 text-lg mt-1 flex items-center gap-2">
                            {linkedCourse ? <><CheckCircle className="text-green-500" size={18} /> {linkedCourse.code ? `${linkedCourse.code} ` : ""}{linkedCourse.name}</> : <span className="text-orange-500">No course linked: press Edit to choose one</span>}
                        </p>
                    </div>
                    {processInfo.externalLink && state === "open" && !oldDb && (
                        <a href={processInfo.externalLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 bg-blue-50 text-blue-700 border border-blue-200 px-4 py-2 rounded-lg font-semibold hover:bg-blue-100 transition shadow-sm">Open the form <ExternalLink size={16} /></a>
                    )}
                </div>

                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                    {([["all", "All", applications.length] as const, ...APP_STATUSES.map(s => [s, s, counts[s]] as const)]).map(([key, label, n]) => (
                        <button key={key} onClick={() => setFilter(key as typeof filter)} className={`text-left rounded-xl p-4 border shadow-sm transition ${filter === key ? "border-blue-500 ring-2 ring-blue-200 bg-white" : "border-slate-200 bg-white hover:border-blue-300"}`}>
                            <p className="text-xs font-semibold uppercase text-slate-500">{label}</p>
                            <p className="text-2xl font-bold text-slate-800">{n}</p>
                        </button>
                    ))}
                </div>

                <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
                    <div className="p-4 border-b border-slate-100 flex items-center gap-3 flex-wrap">
                        <h2 className="text-sm font-semibold text-slate-800">{filter === "all" ? "All applications" : filter} ({shown.length})</h2>
                        <span className="flex items-center gap-2 p-2 border rounded-lg ml-auto"><Search size={16} className="text-slate-400" /><input className="outline-none text-sm" placeholder="Search name, email, phone" value={search} onChange={e => setSearch(e.target.value)} /></span>
                    </div>
                    {loadFailed && <p className="p-4 text-sm text-red-600">Could not load the applications. You may not have permission, or the connection failed.</p>}
                    <div className="divide-y divide-slate-100">
                        {shown.map(app => {
                            const rawFullName = applicantName(app) || 'Unknown Applicant';
                            const tl = transliterate(rawFullName);
                            const display = rawFullName !== tl ? `${rawFullName} (${tl})` : rawFullName;
                            const st = appStatusOf(app.status);
                            return (
                                <div key={app.id} className="flex flex-col md:flex-row md:items-center justify-between p-3 gap-3 hover:bg-slate-50">
                                    <div className="min-w-0">
                                        <button onClick={() => setDetailApp(app)} className="text-sm font-bold text-blue-700 hover:underline text-left">{display}</button>
                                        <div className="flex flex-wrap gap-x-2 text-xs text-slate-500 mt-0.5">
                                            <span>{ukShortDate(app.submittedAt) || "Date unknown"}</span>
                                            {(nationalityOf(app) || app.programme) && <span>· {nationalityOf(app) ? getCountryName(nationalityOf(app)) : String(app.programme)}</span>}
                                            {app.mobile && <span>· {String(app.mobile)}</span>}
                                            {app.studentId && <span>· <Link href={`/admin/students/detail?id=${app.studentId}`} className="text-blue-600 hover:underline">Student record</Link></span>}
                                            {app.declineEmailAt && <span>· polite email sent</span>}
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-3 justify-end flex-wrap">
                                        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${STATUS_STYLE[st]}`}>{st}</span>
                                        {actions(app)}
                                    </div>
                                </div>
                            );
                        })}
                        {shown.length === 0 && !loading && <p className="p-8 text-center text-sm text-slate-500">No applications here.</p>}
                    </div>
                </div>

                {topNationalities.length > 0 && (
                    <div className="bg-white rounded-xl border border-slate-200 p-4">
                        <p className="text-sm font-semibold text-slate-800 mb-2">Nationalities given ({withNationality.length} of {applications.length})</p>
                        <div className="flex flex-wrap gap-2">{topNationalities.map(([n, c]) => <span key={n} className="text-xs px-2 py-1 rounded bg-slate-100 text-slate-700">{n}: {c}</span>)}</div>
                    </div>
                )}
            </div>

            {declineFor && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-xl shadow-lg w-full max-w-lg overflow-hidden">
                        <div className="p-5 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
                            <h3 className="font-bold text-lg text-slate-800">Decline {applicantName(declineFor) || "this applicant"}?</h3>
                            <button onClick={() => setDeclineFor(null)} aria-label="Close"><X size={20} className="text-slate-400" /></button>
                        </div>
                        <div className="p-5 space-y-3 text-sm text-slate-700">
                            <p>The application stays here, marked Declined. You can undo it with &quot;Back to New&quot;.</p>
                            {contactEmail(declineFor) && !oldDb ? (
                                <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={declineEmail} onChange={e => setDeclineEmail(e.target.checked)} />
                                    <span>Send a polite email to <b>{contactEmail(declineFor)}</b> from recruitment@sovereignhousegh.com: &quot;Thank you for applying to {processInfo.title}. Unfortunately we are not able to offer {declineFor.formType === "referral" ? "them" : "you"} a place on this course at the moment. We would be glad to hear from you again for a future course.&quot;</span></label>
                            ) : <p className="text-slate-500">{oldDb ? "No email can be sent until this process is moved into the portal." : "No email address was given, so no email can be sent."}</p>}
                        </div>
                        <div className="p-4 border-t border-slate-100 flex justify-end gap-2">
                            <button onClick={() => setDeclineFor(null)} className="px-4 py-2 text-slate-600 font-medium hover:bg-slate-100 rounded-lg">Cancel</button>
                            <button onClick={confirmDecline} disabled={busyId === declineFor.id} className="px-4 py-2 rounded-lg font-bold bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50">{declineEmail && contactEmail(declineFor) && !oldDb ? "Decline and send" : "Decline"}</button>
                        </div>
                    </div>
                </div>
            )}

            {editOpen && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-xl shadow-lg w-full max-w-lg overflow-hidden">
                        <div className="p-5 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
                            <h3 className="font-bold text-lg text-slate-800">Edit process</h3>
                            <button onClick={() => setEditOpen(false)} aria-label="Close"><X size={20} className="text-slate-400" /></button>
                        </div>
                        <div className="p-5 space-y-3 text-sm">
                            <label className="block"><span className="font-semibold">Name</span><input className="w-full p-2 border rounded mt-1" value={edit.title} onChange={e => setEdit({ ...edit, title: e.target.value })} /></label>
                            <label className="block"><span className="font-semibold">Description (staff only)</span><textarea className="w-full p-2 border rounded mt-1 h-20" value={edit.description} onChange={e => setEdit({ ...edit, description: e.target.value })} /></label>
                            <div className="grid grid-cols-2 gap-3">
                                <label className="block"><span className="font-semibold">Opens on</span><input type="date" className="w-full p-2 border rounded mt-1" value={edit.opensOn} onChange={e => setEdit({ ...edit, opensOn: e.target.value })} /></label>
                                <label className="block"><span className="font-semibold">Closes on</span><input type="date" className="w-full p-2 border rounded mt-1" value={edit.closesOn} onChange={e => setEdit({ ...edit, closesOn: e.target.value })} /></label>
                            </div>
                            <label className="block"><span className="font-semibold">Course accepted applicants join</span>
                                <select className="w-full p-2 border rounded mt-1 bg-white" value={edit.courseId} onChange={e => setEdit({ ...edit, courseId: e.target.value })}>
                                    <option value="">No course</option>
                                    {courses.map(c => <option key={c.id} value={c.id}>{c.code ? `${c.code} ` : ""}{c.name}{c.status ? ` (${c.status})` : ""}</option>)}
                                </select>
                            </label>
                        </div>
                        <div className="p-4 border-t border-slate-100 flex justify-end gap-2">
                            <button onClick={() => setEditOpen(false)} className="px-4 py-2 text-slate-600 font-medium hover:bg-slate-100 rounded-lg">Cancel</button>
                            <button onClick={saveEdit} disabled={saving} className="px-4 py-2 rounded-lg font-bold bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50">{saving ? "Saving…" : "Save"}</button>
                        </div>
                    </div>
                </div>
            )}

            {dupCheck && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-xl shadow-lg w-full max-w-xl overflow-hidden max-h-[85vh] flex flex-col">
                        <div className="flex justify-between items-start p-5 border-b border-amber-200 bg-amber-50 flex-shrink-0">
                            <div>
                                <h3 className="font-bold text-lg text-slate-800">This may already be a student</h3>
                                <p className="text-sm text-slate-600 mt-0.5">{applicantName(dupCheck.app) || "This applicant"} looks like {dupCheck.matches.length === 1 ? "a student" : `${dupCheck.matches.length} students`} we already have. Use the existing record, or create a new one if this is a different person.</p>
                            </div>
                            <button onClick={() => !dupBusy && setDupCheck(null)} aria-label="Close"><X size={20} className="text-slate-400 hover:text-slate-700" /></button>
                        </div>
                        <div className="p-5 overflow-y-auto flex-1 space-y-3">
                            {dupCheck.matches.map(m => {
                                const st = m.student;
                                const arch = st.archived === true;
                                return (
                                    <div key={st.id} className="p-4 border border-slate-200 rounded-lg bg-slate-50">
                                        <div className="flex justify-between items-start gap-3">
                                            <div className="min-w-0">
                                                <Link href={`/admin/students/detail?id=${st.id}`} target="_blank" className="font-bold text-blue-700 hover:underline">{st.name || "No name"}</Link>
                                                {arch && <span className="ml-2 text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-amber-100 text-amber-800">Archived</span>}
                                                <p className="text-xs text-emerald-700 font-semibold mt-1">Same {m.reasons.join(", same ")}</p>
                                                <div className="text-xs text-slate-600 mt-1 space-y-0.5">
                                                    {st.email && <p>Email: {String(st.email)}</p>}
                                                    {st.mobile && <p>Mobile: {String(st.mobile)}</p>}
                                                    {st.dob && <p>Date of birth: {String(st.dob)}</p>}
                                                    {st.postcode && <p>Postcode: {String(st.postcode)}</p>}
                                                </div>
                                            </div>
                                            {arch ? <p className="text-xs text-slate-500 max-w-[160px] text-right">Archived. Restore them on their page first, then accept again.</p>
                                                : <button onClick={() => handleUseExisting(m)} disabled={dupBusy} className="px-3 py-1.5 text-xs font-bold rounded shadow-sm text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 whitespace-nowrap">{dupBusy ? "Working…" : "Use existing"}</button>}
                                        </div>
                                    </div>
                                );
                            })}
                            <p className="text-xs text-slate-500">Use existing enrols them on the linked course, fills only the empty fields of their record from this application, keeps the extra answers, and marks the application accepted.{!dupCheck.dobChecked && " Dates of birth were not checked, because you cannot see private student details."}</p>
                        </div>
                        <div className="p-4 border-t border-slate-100 flex justify-end gap-2 flex-shrink-0">
                            <button onClick={() => setDupCheck(null)} disabled={dupBusy} className="px-4 py-2 text-slate-600 font-medium hover:bg-slate-100 rounded-lg transition">Cancel</button>
                            <button onClick={handleCreateAnyway} disabled={dupBusy} className="px-4 py-2 rounded-lg font-bold border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50">Create new anyway</button>
                        </div>
                    </div>
                </div>
            )}

            {detailApp && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setDetailApp(null)}>
                    <div className="bg-white rounded-xl shadow-lg w-full max-w-lg overflow-hidden max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
                        <div className="flex justify-between items-center p-5 border-b border-slate-100 bg-slate-50 flex-shrink-0">
                            <div>
                                <h3 className="font-bold text-lg text-slate-800">{applicantName(detailApp) || "Application"}</h3>
                                <p className="text-xs text-slate-500 mt-0.5">{appStatusOf(detailApp.status)}{detailApp.importedFrom ? " · moved from the old forms database" : ""}</p>
                            </div>
                            <button onClick={() => setDetailApp(null)} aria-label="Close"><X size={20} className="text-slate-400 hover:text-slate-700" /></button>
                        </div>
                        <div className="p-6 overflow-y-auto flex-1">
                            <div className="space-y-4">
                                {Object.entries(detailApp).filter(([key]) => !HIDDEN_FIELDS.has(key)).map(([key, value]) => {
                                    const formLabels = (detailApp as { labels?: SubmissionLabels }).labels?.questions || {};
                                    const label = formLabels[key] || FIELD_LABELS[key] || key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
                                    return (
                                        <div key={key} className="flex flex-col gap-1 pb-3 border-b border-slate-100 last:border-b-0">
                                            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">{label}</span>
                                            <span className="text-sm text-slate-800 font-medium break-words">{formatFieldValue(key, value)}</span>
                                        </div>
                                    );
                                })}
                                {extraAnswerRows((detailApp as { answers?: Record<string, unknown> }).answers, (detailApp as { labels?: SubmissionLabels }).labels).map(r => (
                                    <div key={r.label} className="flex flex-col gap-1 pb-3 border-b border-slate-100 last:border-b-0">
                                        <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">{r.label}</span>
                                        <span className="text-sm text-slate-800 font-medium break-words">{r.value}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                        {!archived && <div className="p-4 border-t border-slate-100">{actions(detailApp)}</div>}
                    </div>
                </div>
            )}
        </DashboardLayout>
    );
}
