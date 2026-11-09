import { doc, runTransaction, updateDoc } from "firebase/firestore";
import { auth, db, functions } from "@/lib/firebase";
import { stampedBy } from "@/lib/people/changeLog";
import { httpsCallable } from "firebase/functions";
import { LeaveType, UserProfile } from "@/lib/types";
import { isBankHoliday } from "@/lib/bankHolidays";

export const BASE_ALLOWANCE = 20;
export const MAX_CARRY_OVER = 5;

/** leaveAllowance as stored, including the fields the yearly reset writes (30 Sep 2026). */
export type LeaveAllowance = NonNullable<UserProfile["leaveAllowance"]> & { carriedOver?: number; toilAdded?: number };

/** Only staff, admins and super admins have annual leave (Franco, 30 Sep 2026). */
export const LEAVE_ROLES = ["staff", "admin", "super_admin"];
export const hasLeaveRole = (role: string | undefined | null) => LEAVE_ROLES.includes(String(role || ""));

// ---------------------------------------------------------------- leave year

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The year the current leave year started (it runs 1 May to 30 April). 30 Sep 2026 -> 2026, 10 Apr 2027 -> 2026. */
export function leaveYearStart(now: Date = new Date()): number {
    return now.getMonth() >= 4 ? now.getFullYear() : now.getFullYear() - 1;
}

/** "Leave year 1 May 2026 to 30 April 2027". */
export function leaveYearLabel(start: number = leaveYearStart()): string {
    return `Leave year 1 May ${start} to 30 April ${start + 1}`;
}

/** "1 October 2026, 14:05" */
export function formatDateTime(iso: string | null | undefined): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------------------------------------------------------------- yearly reset (server)

export interface LeaveResetRun { at: string | null; by: string; byName?: string; manual: boolean; leaveYear: number; people: number }
export interface LeaveResetPerson { uid: string; name: string; role: string; entitlement: number; daysLeftNow: number | null; carry: number; newBalance: number }
export interface LeaveResetPreview { leaveYear: number; alreadyRunThisYear: boolean; lastRun: LeaveResetRun | null; people: LeaveResetPerson[] }
export interface LeaveResetResult { ran: boolean; count?: number; reason?: string; alreadyRun?: boolean; leaveYear?: number; repeat?: boolean }

/** What the yearly reset would do now, and when it last ran (super admin only). */
export async function fetchLeaveResetPreview(): Promise<LeaveResetPreview> {
    const res = await httpsCallable(functions, "leaveResetPreview")({});
    return res.data as LeaveResetPreview;
}

/**
 * Runs the yearly leave reset NOW on the server (super admin only), in one transaction.
 * If it already ran in this leave year the server does nothing and returns alreadyRun,
 * unless confirmRepeat is true (the page shows a strong warning first).
 */
export async function runAnnualLeaveReset(opts: { confirmRepeat?: boolean } = {}): Promise<LeaveResetResult> {
    const res = await httpsCallable(functions, "resetAnnualLeaveNow")({ confirmRepeat: opts.confirmRepeat === true });
    return res.data as LeaveResetResult;
}

// ---------------------------------------------------------------- days

function parseDay(s: string): Date | null {
    const [y, m, d] = String(s || "").split("-").map(Number);
    if (!y || !m || !d) return null;
    const out = new Date(y, m - 1, d);
    return isNaN(out.getTime()) ? null : out;
}

/**
 * Leave days between two dates, both included. 0 when a date is missing or the end is before the start.
 * - TOIL (days WORKED on weekends or bank holidays): every calendar day counts.
 * - Annual, sick, unpaid: weekends and UK bank holidays are left out.
 */
export function calculateLeaveDays(startDateStr: string, endDateStr: string, type: LeaveType): number {
    const start = parseDay(startDateStr);
    const end = parseDay(endDateStr);
    if (!start || !end || start > end) return 0;

    let count = 0;
    const current = new Date(start);
    while (current <= end) {
        if (type === "toil") {
            count++;
        } else {
            const dayOfWeek = current.getDay(); // 0 = Sunday, 6 = Saturday
            const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
            const utcDate = new Date(Date.UTC(current.getFullYear(), current.getMonth(), current.getDate()));
            if (!isWeekend && !isBankHoliday(utcDate)) count++;
        }
        current.setDate(current.getDate() + 1);
    }
    return count;
}

// ---------------------------------------------------------------- decisions

/**
 * Approves or rejects a pending leave request in one transaction.
 * - Annual leave approved: totalDays come OFF the person's remaining days.
 * - TOIL approved: totalDays are ADDED to remaining (and total).
 * - Sick and unpaid: the balance does not change.
 * - Rejected: a reason is required and saved as rejectionReason.
 */
export async function actionLeaveRequest(
    requestId: string,
    status: "approved" | "rejected",
    approverId: string,
    rejectionReason?: string
): Promise<void> {
    const reason = String(rejectionReason || "").trim();
    if (status === "rejected" && !reason) throw new Error("Please give a reason for rejecting this request.");
    const requestRef = doc(db, "leave_records", requestId);

    try {
        await runTransaction(db, async (transaction) => {
            const requestDoc = await transaction.get(requestRef);
            if (!requestDoc.exists()) throw new Error("This request no longer exists.");

            const requestData = requestDoc.data();
            if (requestData.status !== "pending") throw new Error(`This request has already been ${requestData.status}.`);

            const changesBalance = status === "approved" && (requestData.type === "annual" || requestData.type === "toil");
            if (changesBalance) {
                const userRef = doc(db, "users", requestData.userId);
                const userDoc = await transaction.get(userRef);
                if (!userDoc.exists()) throw new Error("The person who asked for this leave no longer exists.");

                const allowance = userDoc.data().leaveAllowance as LeaveAllowance | undefined;
                if (!allowance || typeof allowance.remaining !== "number") {
                    throw new Error(`${requestData.userName || "This person"} has no leave allowance set yet. Set it on the Allowances tab first.`);
                }
                const days = Number(requestData.totalDays);
                if (!(days > 0)) throw new Error("This request has no valid number of days.");

                if (requestData.type === "annual") {
                    if (allowance.remaining < days) {
                        throw new Error(`Not enough leave left. ${requestData.userName || "This person"} has ${allowance.remaining} days left but asked for ${days}.`);
                    }
                    transaction.update(userRef, { "leaveAllowance.remaining": allowance.remaining - days });
                } else {
                    // TOIL adds days to this year only. The yearly entitlement is kept apart so the
                    // 1 May reset never turns TOIL into entitlement (1 Oct 2026 review).
                    transaction.update(userRef, {
                        "leaveAllowance.remaining": allowance.remaining + days,
                        "leaveAllowance.total": (Number(allowance.total) || 0) + days,
                        "leaveAllowance.entitlement": typeof allowance.entitlement === "number" ? allowance.entitlement : (Number(allowance.total) || 0),
                        "leaveAllowance.toilAdded": (Number(allowance.toilAdded) || 0) + days,
                    });
                }
            }

            const decision: Record<string, unknown> = { status, approvedAt: new Date().toISOString(), approvedBy: approverId };
            if (status === "rejected") decision.rejectionReason = reason;
            transaction.update(requestRef, decision);
        });
    } catch (e: any) {
        if (e?.code === "permission-denied") {
            throw new Error("You are not allowed to make this change. You cannot add TOIL days to your own balance: ask the super admin to approve your own TOIL claim.");
        }
        throw e;
    }
}

// ---------------------------------------------------------------- allowances

/**
 * Saves a person's yearly entitlement (lasting) and the days they have left now.
 * total = entitlement + carriedOver when the reset recorded a carry over, else entitlement.
 */
export async function saveLeaveAllowance(uid: string, current: LeaveAllowance | undefined, entitlement: number, remaining: number): Promise<LeaveAllowance> {
    if (!Number.isFinite(entitlement) || entitlement < 0 || entitlement > 366) throw new Error("The yearly entitlement must be a number from 0 to 366.");
    if (!Number.isFinite(remaining) || remaining < -366 || remaining > 732) throw new Error("Days left now must be a number.");
    const carriedOver = typeof current?.carriedOver === "number" ? current.carriedOver : undefined;
    const next: LeaveAllowance = {
        ...(current || {}),
        entitlement,
        remaining,
        total: entitlement + (carriedOver || 0),
        year: current?.year || leaveYearStart(),
    };
    await updateDoc(doc(db, "users", uid), { leaveAllowance: next, ...stampedBy(auth.currentUser?.uid || "") });
    return next;
}
