// Pure rules for student applications (no Firebase here, so statistics can use them).
// See src/lib/studentApplications.ts for the model.
import type { ApplicationProcess } from "@/lib/types";

export type AppStatus = "New" | "Accepted" | "Waiting list" | "Declined";
export const APP_STATUSES: AppStatus[] = ["New", "Waiting list", "Accepted", "Declined"];

/** Any status ever saved (old forms: pending, Rejected, approved) as one of the four. */
export function appStatusOf(raw: unknown): AppStatus {
    const s = String(raw ?? "").trim().toLowerCase();
    if (s === "accepted" || s === "approved") return "Accepted";
    if (s === "rejected" || s === "declined") return "Declined";
    if (s === "waiting list" || s === "waiting" || s === "waitlist" || s === "waiting-list") return "Waiting list";
    return "New";
}

export const STATUS_STYLE: Record<AppStatus, string> = {
    "New": "bg-blue-50 text-blue-700 border-blue-200",
    "Waiting list": "bg-amber-50 text-amber-800 border-amber-200",
    "Accepted": "bg-green-50 text-green-700 border-green-200",
    "Declined": "bg-slate-100 text-slate-600 border-slate-200",
};

/** Today in the UK as YYYY-MM-DD. */
export function londonToday(now: Date = new Date()): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(now);
}

export type ProcessState = "archived" | "open" | "upcoming" | "closed";

/** Open, not open yet, closed (by hand or by its date), or archived. */
export function processState(p: Partial<ApplicationProcess> & { archived?: boolean; opensOn?: string; closesOn?: string }, today = londonToday()): ProcessState {
    if (p.archived === true) return "archived";
    if (p.status !== "Open") return "closed";
    if (p.closesOn && p.closesOn < today) return "closed";
    if (p.opensOn && p.opensOn > today) return "upcoming";
    return "open";
}

/** Still in the old refugees-appform database (not moved into the portal yet). */
export const isOldDatabase = (p: Partial<ApplicationProcess>) => p.sourceProject === "refugees-appform";

export interface Application {
    id: string;
    processId: string;
    name?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    mobile?: string;
    status?: string;
    submittedAt?: unknown;
    [key: string]: unknown;
}

/** A submittedAt of any kind (Timestamp, Date, ISO text) as milliseconds, 0 when unknown. */
export function whenMs(v: unknown): number {
    if (!v) return 0;
    if (typeof (v as { toMillis?: () => number }).toMillis === "function") return (v as { toMillis: () => number }).toMillis();
    if (typeof (v as { seconds?: number }).seconds === "number") return (v as { seconds: number }).seconds * 1000;
    if (v instanceof Date) return v.getTime();
    const t = Date.parse(String(v));
    return isNaN(t) ? 0 : t;
}

export function countByStatus(apps: { status?: unknown }[]): Record<AppStatus, number> {
    const out: Record<AppStatus, number> = { "New": 0, "Waiting list": 0, "Accepted": 0, "Declined": 0 };
    apps.forEach(a => { out[appStatusOf(a.status)]++; });
    return out;
}

/** "3 Oct 2026" */
export function ukShortDate(v: unknown): string {
    const ms = typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(v + "T12:00:00Z") : whenMs(v);
    if (!ms) return "";
    return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" });
}
