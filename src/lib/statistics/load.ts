// Loads everything the Statistics page counts, ONCE, and keeps it for 10 minutes per person in
// sessionStorage. Every part is read on its own: a part the rules refuse (or a network error) is
// listed in `failed` and its section says "Could not load", never a silent 0.
//
// Only the fields the figures need are kept (no phone numbers, notes, PINs, class report text,
// application answers or dates of birth: an age is kept instead), and every date becomes a plain string, so the cache holds as little
// personal data as possible.
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { db as refugeesDb } from "@/lib/firebase-refugees";
import { loadStatsData, type StatsPart } from "@/lib/statsLoader";
import type { StatsData } from "@/lib/stats";
import { loadStudentPrivateMap } from "@/lib/studentPrivate";
import { loadPolicies, loadReadMap, type PolicyDoc } from "@/lib/policies";
import { loadAnnouncements } from "@/lib/announcements";

type Any = Record<string, any>;

/** A Firestore Timestamp, Date, ISO text or "dd/mm/yyyy" as an ISO style string (or undefined). */
export function toIso(v: any): string | undefined {
    if (v === null || v === undefined || v === "") return undefined;
    if (typeof v === "string") {
        const uk = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (uk) return `${uk[3]}-${uk[2].padStart(2, "0")}-${uk[1].padStart(2, "0")}`;
        return v;
    }
    try {
        if (typeof v.toDate === "function") return v.toDate().toISOString();
        if (v instanceof Date) return isNaN(v.getTime()) ? undefined : v.toISOString();
        if (typeof v.seconds === "number") return new Date(v.seconds * 1000).toISOString();
    } catch { /* unreadable date */ }
    return undefined;
}

const str = (v: any) => (v === null || v === undefined ? "" : String(v));

/** Age today from a date of birth, so the cache never holds the date itself. */
function dobAge(dob: unknown, now: Date = new Date()): number | undefined {
    const d = toIso(dob)?.slice(0, 10);
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return undefined;
    const [y, m, dd] = d.split("-").map(Number);
    let a = now.getFullYear() - y;
    if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < dd)) a--;
    return a >= 0 && a < 120 ? a : undefined;
}

export interface RawClassReport { courseId: string; date?: string; volunteerId?: string }
export interface RawBadge { id: string; name: string; category?: string; archived?: boolean }
export interface RawEarned { badgeId: string; volunteerId: string; earnedAt?: string }
export interface RawLeave { userId: string; userName?: string; type: string; status: string; totalDays: number; startDate?: string; endDate?: string; createdAt?: string }
export interface RawVolApp { status: string; role?: string; heardFrom?: string; submittedAt?: string; hadInterview: boolean; outcome?: string }
export interface RawProcess { id: string; title: string; formType?: string; status?: string; sourceProject?: string; courseId?: string; archived?: boolean }
export interface RawSubmission { processId: string; status?: string; submittedAt?: string; formType?: string }
export interface RawItem { location?: string; type?: string; activity?: string }
export interface RawDonated { donatedTo?: string; donatedAt?: string; type?: string }
export interface RawWasted { wastedAt?: string; type?: string }
export interface RawAnnouncement { severity: string; audience: string; expiresAt?: string; createdDay?: string }
export interface RawSocialPost { network: string; status: string; createdAt?: string; publishedAt?: string }
export interface RawGrant { status: string; amount: number; amountRequested: number; grantProgress?: string; deadline?: string; parentId?: string | null }
export interface RawRead { userId: string; policyId: string; version: number }

export interface StatsRaw {
    data: StatsData;
    pendingActivities: Any[] | null;
    classRecords: RawClassReport[] | null;
    /** null: the private student details (age from date of birth, ethnicity, nationality) are not readable. */
    studentPrivate: Record<string, { dobAge?: number; ethnicity?: string; nationality?: string }> | null;
    badges: RawBadge[] | null;
    earned: RawEarned[] | null;
    leave: RawLeave[] | null;
    policies: PolicyDoc[] | null;
    reads: RawRead[] | null;
    readsPartial: boolean;
    volunteerApps: RawVolApp[] | null;
    processes: RawProcess[] | null;
    submissions: RawSubmission[] | null;
    /** Titles of application processes whose answers could not be read. */
    submissionFailures: string[];
    inventory: RawItem[] | null;
    donated: RawDonated[] | null;
    wasted: RawWasted[] | null;
    announcements: RawAnnouncement[] | null;
    socialPosts: RawSocialPost[] | null;
    grants: RawGrant[] | null;
}

export interface LoadResult { raw: StatsRaw; failed: string[]; at: number }

const PART_LABEL: Record<StatsPart, string> = {
    courses: "courses", students: "students", users: "people", roster: "course rosters", assignments: "course teachers",
    attendance: "registers", oneToOne: "1-2-1 sessions", activities: "logged hours",
};

/** Keeps only the fields the figures use. */
function slimData(d: StatsData): StatsData {
    return {
        courses: (d.courses || []).map(c => ({
            id: c.id, code: str(c.code), name: str(c.name), type: c.type, status: c.status,
            schedule: c.schedule ? { day: c.schedule.day, start: c.schedule.start, end: c.schedule.end } : null,
            startDate: toIso(c.startDate), endDate: toIso(c.endDate), setting: str(c.setting), venue: str(c.venue), createdAt: toIso(c.createdAt),
        })),
        students: d.students?.map(s => ({
            id: s.id, name: str(s.name), archived: s.archived === true, createdAt: toIso(s.createdAt),
            age: s.age, dobAge: dobAge(s.dob), gender: str(s.gender) || undefined,
            nationality: str(s.nationality) || undefined, ethnicity: str(s.ethnicity) || undefined, postcode: str(s.postcode) || undefined,
        })),
        users: d.users?.map(u => ({
            id: u.id, name: str(u.displayName || u.name || u.fullName || u.email), role: u.role, archived: u.archived === true,
            managerId: u.managerId || undefined, createdAt: toIso(u.createdAt),
            leaveAllowance: u.leaveAllowance ? {
                total: u.leaveAllowance.total, remaining: u.leaveAllowance.remaining, year: u.leaveAllowance.year,
                entitlement: u.leaveAllowance.entitlement, carriedOver: u.leaveAllowance.carriedOver,
            } : undefined,
        })),
        roster: d.roster?.map(r => ({ courseId: r.courseId, studentId: r.studentId, enrolledAt: toIso(r.enrolledAt) })),
        assignments: d.assignments?.map(a => ({ courseId: a.courseId, volunteerId: a.volunteerId })),
        attendance: d.attendance?.map(a => ({ courseId: a.courseId, date: a.date, studentId: a.studentId || undefined, userId: a.userId || undefined, held: a.held === true || undefined })),
        oneToOne: d.oneToOne?.map(o => ({ courseId: o.courseId, studentId: o.studentId, volunteerId: o.volunteerId, date: toIso(o.date), durationMinutes: o.durationMinutes })),
        activities: d.activities?.map(a => ({ volunteerId: a.volunteerId, hours: a.hours, status: a.status, date: toIso(a.date), createdAt: toIso(a.createdAt) })),
    };
}

/** JSON can drop undefined values safely; this keeps the cache small. */
function stripUndefined<T>(v: T): T {
    return JSON.parse(JSON.stringify(v));
}

async function part<T>(label: string, failed: string[], fn: () => Promise<T>): Promise<T | null> {
    try {
        return await fn();
    } catch (e) {
        console.warn(`Statistics: could not load ${label}`, e);
        failed.push(label);
        return null;
    }
}

async function readAll(name: string): Promise<Any[]> {
    const snap = await getDocs(collection(db, name));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function loadStatistics(): Promise<LoadResult> {
    const failed: string[] = [];
    const [core, pending, reports, priv, badges, earned, leave, policies, reads, volApps, processes, inventory, donated, wasted, announcements, social, grants] = await Promise.all([
        loadStatsData(["courses", "students", "users", "roster", "assignments", "attendance", "oneToOne", "activities"]),
        part("pending hours", failed, async () => (await getDocs(query(collection(db, "volunteerActivities"), where("status", "==", "pending")))).docs
            .map(d => { const a = d.data(); return { volunteerId: a.volunteerId, hours: a.hours, status: "pending", date: toIso(a.date), createdAt: toIso(a.createdAt) }; })),
        part("class reports", failed, async () => (await readAll("classRecords")).map(r => ({ courseId: str(r.courseId), date: toIso(r.date), volunteerId: r.volunteerId ? str(r.volunteerId) : undefined }))),
        (async () => {
            const map = await loadStudentPrivateMap();
            if (!map) return null;
            const out: Record<string, { dobAge?: number; ethnicity?: string; nationality?: string }> = {};
            map.forEach((v, k) => { out[k] = { dobAge: dobAge(v.dob), ethnicity: str(v.ethnicity) || undefined, nationality: str(v.nationality) || undefined }; });
            return out;
        })(),
        part("badges", failed, async () => (await readAll("achievementsBadges")).map(b => ({ id: b.id, name: str(b.name) || "Unnamed badge", category: b.category ? str(b.category) : undefined, archived: b.archived === true }))),
        part("badges earned", failed, async () => (await readAll("earnedAchievements")).map(e => ({ badgeId: str(e.badgeId), volunteerId: str(e.volunteerId || e.userId), earnedAt: toIso(e.earnedAt) }))),
        part("annual leave", failed, async () => (await readAll("leave_records")).map(l => ({
            userId: str(l.userId), userName: str(l.userName), type: str(l.type) || "annual", status: str(l.status) || "pending",
            totalDays: Number(l.totalDays) || 0, startDate: toIso(l.startDate), endDate: toIso(l.endDate), createdAt: toIso(l.createdAt),
        }))),
        part("policies", failed, () => loadPolicies()),
        part("policy reading", failed, async () => {
            const { map, partial } = await loadReadMap();
            const list: RawRead[] = [];
            map.forEach((byPolicy, userId) => byPolicy.forEach(r => list.push({ userId, policyId: r.policyId, version: r.version })));
            return { list, partial };
        }),
        part("volunteer applications", failed, async () => (await readAll("volunteer_applications")).map(a => ({
            status: str(a.status) || "new", role: a.role ? str(a.role) : undefined, heardFrom: a.heardFrom ? str(a.heardFrom) : undefined,
            submittedAt: toIso(a.submittedAt || a.appliedAt), hadInterview: !!(a.interview && a.interview.start), outcome: a.decision?.outcome ? str(a.decision.outcome) : undefined,
        }))),
        part("student applications", failed, async () => (await readAll("applicationProcesses")).filter(p => !p.isFormLink)),
        part("inventory", failed, async () => (await readAll("laptopInventory")).map(i => ({ location: str(i.location) || "Unknown", type: str(i.type) || "Laptop", activity: str(i.activity) || "Not recorded" }))),
        part("donated items", failed, async () => (await readAll("donatedInventory")).map(i => ({ donatedTo: str(i.donatedTo) || undefined, donatedAt: toIso(i.donatedAt), type: str(i.type) || "Laptop" }))),
        part("wasted items", failed, async () => (await readAll("wastedInventory")).map(i => ({ wastedAt: toIso(i.wastedAt), type: str(i.type) || "Laptop" }))),
        part("announcements", failed, async () => (await loadAnnouncements(1000)).map(a => ({ severity: a.severity, audience: a.audience, expiresAt: a.expiresAt, createdDay: a.createdDay }))),
        part("social media posts", failed, async () => (await readAll("socialPosts")).map(p => ({ network: str(p.network) || "unknown", status: str(p.status) || "draft", createdAt: toIso(p.createdAt), publishedAt: toIso(p.publishedAt) }))),
        part("grants", failed, async () => (await readAll("grants")).map(g => ({
            status: str(g.status) || "Unknown", amount: Number(g.amount) || 0, amountRequested: Number(g.amountRequested) || 0,
            grantProgress: g.grantProgress ? str(g.grantProgress) : undefined, deadline: toIso(g.deadline), parentId: g.parentId || null,
        }))),
    ]);
    core.failed.forEach(p => failed.push(PART_LABEL[p] || p));
    if (priv === null) failed.push("private student details (age, ethnicity, nationality)");

    // Student application answers: one read per process, from the project that holds them.
    let procList: RawProcess[] | null = null;
    let submissions: RawSubmission[] | null = null;
    const submissionFailures: string[] = [];
    if (processes) {
        procList = processes.map(p => ({ id: p.id, title: str(p.title) || "Untitled process", formType: p.formType ? str(p.formType) : undefined, status: str(p.status) || undefined, sourceProject: str(p.sourceProject) || "main", courseId: p.courseId ? str(p.courseId) : undefined, archived: p.archived === true ? true : undefined }));
        submissions = [];
        await Promise.all(processes.map(async p => {
            try {
                const fs = p.sourceProject === "refugees-appform" ? refugeesDb : db;
                const snap = await getDocs(collection(fs, str(p.collectionName) || "applications"));
                snap.forEach(d => {
                    const s = d.data();
                    submissions!.push({ processId: p.id, status: s.status ? str(s.status) : undefined, submittedAt: toIso(s.submittedAt || s.createdAt || s.timestamp), formType: s.formType ? str(s.formType) : (p.formType ? str(p.formType) : undefined) });
                });
            } catch (e) {
                console.warn(`Statistics: could not read the applications of ${p.title}`, e);
                submissionFailures.push(str(p.title) || p.id);
            }
        }));
        if (submissionFailures.length > 0) failed.push(`applications of ${submissionFailures.length} student application process${submissionFailures.length === 1 ? "" : "es"}`);
    }

    const raw: StatsRaw = stripUndefined({
        data: slimData(core.data),
        pendingActivities: pending,
        classRecords: reports,
        studentPrivate: priv,
        badges, earned, leave,
        policies,
        reads: reads ? reads.list : null,
        readsPartial: !!reads?.partial,
        volunteerApps: volApps,
        processes: procList,
        submissions,
        submissionFailures,
        inventory, donated, wasted,
        announcements,
        socialPosts: social,
        grants,
    });
    if (reads?.partial) failed.push("part of the policy reading records");
    return { raw, failed, at: Date.now() };
}

// ---------------------------------------------------------------- 10 minute cache

const CACHE_MS = 10 * 60 * 1000;
const cacheKey = (uid: string) => `shgh.statistics.v1.${uid}`;

export function readCache(uid: string): LoadResult | null {
    try {
        const s = sessionStorage.getItem(cacheKey(uid));
        if (!s) return null;
        const hit = JSON.parse(s) as LoadResult;
        if (!hit || typeof hit.at !== "number" || Date.now() - hit.at > CACHE_MS || !hit.raw?.data) return null;
        return hit;
    } catch {
        return null;
    }
}

export function writeCache(uid: string, result: LoadResult): void {
    try {
        sessionStorage.setItem(cacheKey(uid), JSON.stringify(result));
    } catch {
        // Storage full or blocked: the page still works, it just reads again next time.
        try { sessionStorage.removeItem(cacheKey(uid)); } catch { /* nothing to do */ }
    }
}
