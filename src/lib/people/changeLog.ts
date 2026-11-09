/**
 * People change log (1 Oct 2026).
 *
 * changeLog is written ONLY by the server (functions/people.js, usersChangeLog) whenever
 * role, permissions, deniedPermissions, managerId, archived or leaveAllowance.entitlement
 * changes on a users document. One document per changed field:
 *   { at, targetUid, targetName, field, before, after, byUid, source: 'users' }
 * Admins and super admins can read it; nobody can write it.
 *
 * Who made the change comes from users/{uid}.updatedBy, so every page that changes one of
 * those fields should also write stampedBy(uid) (updatedBy + updatedAt) in the same update.
 */

import { collection, getDocs, limit, orderBy, query, serverTimestamp, Timestamp, where } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { PERMISSION_CATALOG } from "@/lib/permissions";

export type ChangeField =
    | "role"
    | "permissions"
    | "deniedPermissions"
    | "managerId"
    | "archived"
    | "leaveAllowance.entitlement";

export interface ChangeLogEntry {
    id: string;
    at: Date | null;
    targetUid: string;
    targetName: string;
    field: ChangeField | string;
    before: unknown;
    after: unknown;
    byUid: string;
    source: string;
}

/** Fields to add to any update of users/{uid} so the change log knows who did it. */
export function stampedBy(uid: string | null | undefined): { updatedBy: string; updatedAt: ReturnType<typeof serverTimestamp> } {
    return { updatedBy: uid || "unknown", updatedAt: serverTimestamp() };
}

function toEntry(id: string, d: Record<string, any>): ChangeLogEntry {
    const at = d.at instanceof Timestamp ? d.at.toDate() : (d.at && typeof d.at.toDate === "function" ? d.at.toDate() : null);
    return {
        id,
        at,
        targetUid: String(d.targetUid || ""),
        targetName: String(d.targetName || d.targetUid || ""),
        field: String(d.field || ""),
        before: d.before ?? null,
        after: d.after ?? null,
        byUid: String(d.byUid || "unknown"),
        source: String(d.source || ""),
    };
}

const newestFirst = (a: ChangeLogEntry, b: ChangeLogEntry) => (b.at?.getTime() ?? Number.MAX_SAFE_INTEGER) - (a.at?.getTime() ?? Number.MAX_SAFE_INTEGER);

/** The newest changes for everyone (default 200). */
export async function loadRecentChanges(max = 200): Promise<ChangeLogEntry[]> {
    const snap = await getDocs(query(collection(db, "changeLog"), orderBy("at", "desc"), limit(max)));
    return snap.docs.map(d => toEntry(d.id, d.data())).sort(newestFirst);
}

/**
 * The changes for one person, newest first. Sorted here rather than in the query so no
 * composite index (targetUid + at) is needed.
 */
export async function loadChangesFor(uid: string, max = 200): Promise<ChangeLogEntry[]> {
    if (!uid) return [];
    const snap = await getDocs(query(collection(db, "changeLog"), where("targetUid", "==", uid), limit(1000)));
    return snap.docs.map(d => toEntry(d.id, d.data())).sort(newestFirst).slice(0, max);
}

export const FIELD_LABELS: Record<string, string> = {
    role: "Role",
    permissions: "Extra features",
    deniedPermissions: "Features switched off",
    managerId: "Line manager",
    archived: "Archived",
    "leaveAllowance.entitlement": "Yearly leave entitlement",
};

export function fieldLabel(field: string): string {
    return FIELD_LABELS[field] || field;
}

const PERMISSION_LABELS: Record<string, string> = Object.fromEntries(PERMISSION_CATALOG.map(p => [p.key, p.label]));

/** A value as plain text. nameOf turns a uid into a name (for line managers). */
export function formatChangeValue(field: string, value: unknown, nameOf: (uid: string) => string): string {
    if (value === null || value === undefined || value === "") {
        if (field === "archived") return "No";
        if (field === "permissions" || field === "deniedPermissions") return "None";
        return "Not set";
    }
    switch (field) {
        case "role":
            return String(value).replace(/_/g, " ");
        case "permissions":
        case "deniedPermissions":
            return Array.isArray(value) && value.length
                ? value.map(k => PERMISSION_LABELS[String(k)] || String(k)).join(", ")
                : "None";
        case "managerId":
            return nameOf(String(value));
        case "archived":
            return value === true ? "Yes" : "No";
        case "leaveAllowance.entitlement":
            return `${value} ${value === 1 ? "day" : "days"}`;
        default:
            return typeof value === "object" ? JSON.stringify(value) : String(value);
    }
}

/** 'Wed 1 Oct 2026, 14:05' in UK time. */
export function formatChangeTime(at: Date | null): string {
    if (!at) return "Just now";
    return new Intl.DateTimeFormat("en-GB", {
        weekday: "short", day: "numeric", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit", timeZone: "Europe/London",
    }).format(at);
}
