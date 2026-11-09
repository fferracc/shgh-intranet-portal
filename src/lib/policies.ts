// Policies (30 Sep 2026, Franco's decisions). Shared rules for the portal Policy Hub and,
// mirrored by hand, the UK app (UK App/index.html, search "POLICY RULES").
//
//   - Every policy has an audience: 'staff', 'volunteers' or 'everyone'. Missing = 'everyone',
//     so nothing disappears for anyone who could see it before.
//   - Every policy has a version (a whole number). Missing = 1. Uploading a new version adds 1,
//     and everyone who must read it has to read it again.
//   - Staff, admins and the super admin must read 'staff' and 'everyone' policies.
//     Volunteers must read 'volunteers' and 'everyone' policies.
//   - A read counts when the version on the read record (missing = 1) is at least the
//     policy's current version.
//   - Portal reads live in policy_tracking {userId, policyId, version, readAt, openedAt};
//     app reads live in readConfirmations {volunteerId, policyId, version, readAt, openedAt}.
//     loadReadMap() merges both into one "who read what version" map, one entry per person
//     and policy (the highest version wins), so duplicates never count twice.
import { collection, deleteDoc, doc, getDocs, query, serverTimestamp, setDoc, addDoc, updateDoc, where } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { londonToday } from "@/lib/registers";

export type PolicyAudience = "staff" | "volunteers" | "everyone";
export type AudienceGroup = "staff" | "volunteers";

export const AUDIENCE_OPTIONS: { value: PolicyAudience; label: string }[] = [
    { value: "everyone", label: "Everyone (staff and volunteers)" },
    { value: "staff", label: "Staff only" },
    { value: "volunteers", label: "Volunteers only" },
];

export const AUDIENCE_LABEL: Record<PolicyAudience, string> = {
    everyone: "Everyone",
    staff: "Staff",
    volunteers: "Volunteers",
};

export interface PolicyDoc {
    id: string;
    title: string;
    /** The document: a link (usually Google Drive) or, for a few old app entries, plain text. */
    link: string;
    isUrl: boolean;
    category?: string;
    audience: PolicyAudience;
    version: number;
    versionNote?: string;
    /** 'YYYY-MM-DD' in UK time, or undefined. */
    createdDay?: string;
    updatedDay?: string;
}

export interface PolicyReadRecord {
    userId: string;
    policyId: string;
    version: number;
    readDay?: string;
    source: "portal" | "app";
}

/** userId -> policyId -> the best read record (highest version). */
export type ReadMap = Map<string, Map<string, PolicyReadRecord>>;

export function policyAudience(p: { audience?: unknown } | null | undefined): PolicyAudience {
    const a = String(p?.audience ?? "").trim().toLowerCase();
    if (a === "staff") return "staff";
    if (a === "volunteers" || a === "volunteer") return "volunteers";
    return "everyone";
}

/** Version as a whole number; missing, "1.0" or anything unreadable is 1. */
export function policyVersion(p: { version?: unknown } | null | undefined): number {
    const n = typeof p?.version === "number" ? p.version : parseFloat(String(p?.version ?? ""));
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/** Which reading group a role belongs to; null for roles that do not have to read policies. */
export function audienceGroup(role: unknown): AudienceGroup | null {
    const r = String(role ?? "").trim().toLowerCase();
    if (r === "staff" || r === "admin" || r === "super_admin") return "staff";
    if (r === "volunteer") return "volunteers";
    return null;
}

/** Must someone with this role read this policy? */
export function mustRead(policy: { audience?: unknown }, role: unknown): boolean {
    const group = audienceGroup(role);
    if (!group) return false;
    const a = policyAudience(policy);
    return a === "everyone" || a === group;
}

/** Does this read record count for the policy's current version? */
export function readCounts(record: { version?: unknown } | null | undefined, policy: { version?: unknown }): boolean {
    if (!record) return false;
    return policyVersion(record) >= policyVersion(policy);
}

/** Only admins and the super admin add, edit, replace or delete policies. */
export function canManagePolicies(user: { role?: unknown } | null | undefined): boolean {
    const r = String(user?.role ?? "").toLowerCase();
    return r === "admin" || r === "super_admin";
}

export const isHttpUrl = (s: string) => /^https?:\/\//i.test(s.trim());

function dayOf(v: any): string | undefined {
    if (!v) return undefined;
    if (typeof v === "string") return v.slice(0, 10);
    let d: Date | undefined;
    if (typeof v.toDate === "function") d = v.toDate();
    else if (v instanceof Date) d = v;
    else if (typeof v.seconds === "number") d = new Date(v.seconds * 1000);
    return d && !isNaN(d.getTime()) ? londonToday(d) : undefined;
}

export function toPolicy(id: string, d: any): PolicyDoc {
    const link = String(d?.content || d?.url || d?.link || "").trim();
    return {
        id,
        title: String(d?.title || "Untitled policy"),
        link,
        isUrl: isHttpUrl(link),
        category: d?.category ? String(d.category) : undefined,
        audience: policyAudience(d),
        version: policyVersion(d),
        versionNote: d?.versionNote ? String(d.versionNote) : undefined,
        createdDay: dayOf(d?.createdAt),
        updatedDay: dayOf(d?.updatedAt),
    };
}

export async function loadPolicies(): Promise<PolicyDoc[]> {
    const snap = await getDocs(collection(db, "policyResources"));
    return snap.docs
        .map(s => toPolicy(s.id, s.data()))
        .sort((a, b) => a.title.localeCompare(b.title, "en-GB"));
}

function addRecord(map: ReadMap, rec: PolicyReadRecord) {
    if (!rec.userId || !rec.policyId) return;
    let byPolicy = map.get(rec.userId);
    if (!byPolicy) { byPolicy = new Map(); map.set(rec.userId, byPolicy); }
    const prev = byPolicy.get(rec.policyId);
    if (!prev || rec.version > prev.version) byPolicy.set(rec.policyId, rec);
}

/**
 * Loads portal and app reads into one map.
 * userId given: only that person's reads (what staff are allowed to read).
 * No userId: everyone's reads (admins only; the rules refuse anyone else).
 * `partial` is true when one of the two sources could not be read, so figures may be low.
 */
export async function loadReadMap(userId?: string): Promise<{ map: ReadMap; partial: boolean }> {
    const map: ReadMap = new Map();
    const portalQ = userId
        ? query(collection(db, "policy_tracking"), where("userId", "==", userId))
        : collection(db, "policy_tracking");
    const appQ = userId
        ? query(collection(db, "readConfirmations"), where("volunteerId", "==", userId))
        : collection(db, "readConfirmations");
    const [portal, app] = await Promise.allSettled([getDocs(portalQ), getDocs(appQ)]);
    let partial = false;
    if (portal.status === "fulfilled") {
        portal.value.forEach(s => {
            const d = s.data();
            addRecord(map, { userId: String(d.userId || ""), policyId: String(d.policyId || ""), version: policyVersion(d), readDay: dayOf(d.readAt), source: "portal" });
        });
    } else { partial = true; console.warn("policy_tracking could not be read", portal.reason); }
    if (app.status === "fulfilled") {
        app.value.forEach(s => {
            const d = s.data();
            addRecord(map, { userId: String(d.volunteerId || ""), policyId: String(d.policyId || ""), version: policyVersion(d), readDay: dayOf(d.readAt), source: "app" });
        });
    } else { partial = true; console.warn("readConfirmations could not be read", app.reason); }
    if (portal.status === "rejected" && app.status === "rejected") throw portal.reason;
    return { map, partial };
}

/** The read record this person has for this policy (any version), or undefined. */
export function readRecordOf(map: ReadMap, userId: string, policyId: string): PolicyReadRecord | undefined {
    return map.get(userId)?.get(policyId);
}

/**
 * Saves a portal read. One document per person, policy and version, so reading a new
 * version creates a new document (the rules allow create only, never update).
 */
export async function markPolicyRead(userId: string, policy: PolicyDoc, openedAt: string): Promise<void> {
    try {
        await setDoc(doc(db, "policy_tracking", `${userId}_${policy.id}_v${policy.version}`), {
            userId,
            policyId: policy.id,
            version: policy.version,
            openedAt,
            readAt: new Date().toISOString(),
        });
    } catch (e: any) {
        // Already marked as read for this version (double click, two tabs): the rules refuse an
        // overwrite, and that is fine.
        if (String(e?.code || "").includes("permission-denied")) return;
        throw e;
    }
}

// ---------- Managing policies (admins and the super admin) ----------

export interface PolicyInput {
    title: string;
    link: string;
    category?: string;
    audience: PolicyAudience;
}

export async function createPolicy(input: PolicyInput, byUid: string): Promise<void> {
    await addDoc(collection(db, "policyResources"), {
        title: input.title.trim(),
        content: input.link.trim(),
        category: input.category?.trim() || "",
        audience: input.audience,
        version: 1,
        createdAt: serverTimestamp(),
        createdBy: byUid,
        updatedAt: serverTimestamp(),
        updatedBy: byUid,
    });
}

/** Edits the details. The version stays the same, so nobody has to read it again. */
export async function updatePolicy(id: string, input: PolicyInput, byUid: string): Promise<void> {
    await updateDoc(doc(db, "policyResources", id), {
        title: input.title.trim(),
        content: input.link.trim(),
        category: input.category?.trim() || "",
        audience: input.audience,
        updatedAt: serverTimestamp(),
        updatedBy: byUid,
    });
}

/** Replaces the document with a new version: everyone who must read it has to read it again. */
export async function uploadNewVersion(policy: PolicyDoc, link: string, versionNote: string, byUid: string): Promise<number> {
    const version = policy.version + 1;
    await updateDoc(doc(db, "policyResources", policy.id), {
        content: link.trim(),
        version,
        versionNote: versionNote.trim(),
        updatedAt: serverTimestamp(),
        updatedBy: byUid,
    });
    return version;
}

export async function deletePolicy(id: string): Promise<void> {
    await deleteDoc(doc(db, "policyResources", id));
}

// ---------- Figures ----------

export interface PolicyPerson { uid: string; name: string; group: AudienceGroup }

export interface GroupCount { read: number; total: number }

export interface PolicyStats {
    staff: GroupCount;
    volunteers: GroupCount;
    all: GroupCount;
    notRead: PolicyPerson[];
}

export const pct = (c: GroupCount): number | null => (c.total > 0 ? Math.min(100, Math.round((c.read / c.total) * 100)) : null);

/** People who have to read policies: not archived, with a staff or volunteer role. */
export async function loadPolicyPeople(): Promise<PolicyPerson[]> {
    const snap = await getDocs(collection(db, "users"));
    const people: PolicyPerson[] = [];
    snap.forEach(s => {
        const d = s.data();
        if (d.archived === true) return;
        const group = audienceGroup(d.role);
        if (!group) return;
        people.push({ uid: s.id, name: String(d.displayName || d.name || d.email || s.id), group });
    });
    return people.sort((a, b) => a.name.localeCompare(b.name, "en-GB"));
}

/**
 * Per policy "X of Y read". Only people who must read the policy are counted, each at most
 * once, and only reads of the current version, so a figure can never pass 100%.
 * Reads of deleted policies never appear because only existing policies are counted.
 */
export function policyStats(policies: PolicyDoc[], people: PolicyPerson[], reads: ReadMap): { byPolicy: Record<string, PolicyStats>; totals: { staff: GroupCount; volunteers: GroupCount; all: GroupCount } } {
    const byPolicy: Record<string, PolicyStats> = {};
    const totals = { staff: { read: 0, total: 0 }, volunteers: { read: 0, total: 0 }, all: { read: 0, total: 0 } };
    for (const p of policies) {
        const s: PolicyStats = { staff: { read: 0, total: 0 }, volunteers: { read: 0, total: 0 }, all: { read: 0, total: 0 }, notRead: [] };
        for (const person of people) {
            const role = person.group === "staff" ? "staff" : "volunteer";
            if (!mustRead(p, role)) continue;
            const done = readCounts(readRecordOf(reads, person.uid, p.id), p);
            const g = s[person.group];
            g.total++; s.all.total++;
            if (done) { g.read++; s.all.read++; } else s.notRead.push(person);
        }
        byPolicy[p.id] = s;
        totals.staff.read += s.staff.read; totals.staff.total += s.staff.total;
        totals.volunteers.read += s.volunteers.read; totals.volunteers.total += s.volunteers.total;
        totals.all.read += s.all.read; totals.all.total += s.all.total;
    }
    return { byPolicy, totals };
}

/**
 * One person's own figures (for the dashboard tile, for example):
 * policies they must read, and how many of those they have read in the current version.
 */
export async function myPolicyCompliance(user: { uid: string; role?: unknown }): Promise<{ read: number; total: number; percent: number }> {
    const [policies, { map }] = await Promise.all([loadPolicies(), loadReadMap(user.uid)]);
    const required = policies.filter(p => mustRead(p, user.role));
    const read = required.filter(p => readCounts(readRecordOf(map, user.uid, p.id), p)).length;
    const total = required.length;
    return { read, total, percent: total > 0 ? Math.min(100, Math.round((read / total) * 100)) : 100 };
}
