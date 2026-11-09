// Volunteer counts for the dashboard (30 Sep 2026, Franco). Built on src/lib/stats.ts
// (the same "classes taught" and "approved hours" rules as the badges); nothing here reads Firestore.
//
//   Active (last N days): anyone of ANY role (volunteers, staff, admins) who taught a class
//     (a teacher tick on a register) or a 1-2-1 session, or has approved hours dated in the
//     last N days. Archived people are left out: this is a "now" figure.
//   Registered volunteers: role "volunteer", not archived.
//   Historic: anyone who has ever taught a class or a 1-2-1 session (archived people included).
import { isArchived, normRole, todayStr, volunteerHoursByPerson, type DateRange, type StatsData } from "@/lib/stats";

export const ACTIVE_DAYS = 90;

/** The last `days` days up to today, both ends included. */
export function lastDays(days: number, now: Date = new Date()): DateRange {
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
    return { from: todayStr(from), to: todayStr(now) };
}

/** Existing, non-archived users who taught or had approved hours in the last `days` days. */
export function activeInLastDays(data: StatsData, days: number = ACTIVE_DAYS, now: Date = new Date()): Set<string> {
    const hours = volunteerHoursByPerson(data, lastDays(days, now));
    return new Set((data.users || [])
        .filter(u => !isArchived(u))
        .filter(u => { const h = hours[u.id]; return !!h && (h.classes > 0 || h.otherHours > 0); })
        .map(u => u.id));
}

/** Role volunteer, not archived. */
export function registeredVolunteerIds(data: StatsData): Set<string> {
    return new Set((data.users || []).filter(u => !isArchived(u) && normRole(u.role) === "volunteer").map(u => u.id));
}

/** Existing users (archived included) who have ever taught a class or a 1-2-1 session. */
export function historicTeacherIds(data: StatsData): Set<string> {
    const hours = volunteerHoursByPerson(data);
    return new Set((data.users || []).filter(u => (hours[u.id]?.classes || 0) > 0).map(u => u.id));
}

export interface VolunteerCounts { active: number; activeDays: number; registered: number; historic: number }

export function volunteerCounts(data: StatsData, now: Date = new Date()): VolunteerCounts {
    return {
        active: activeInLastDays(data, ACTIVE_DAYS, now).size,
        activeDays: ACTIVE_DAYS,
        registered: registeredVolunteerIds(data).size,
        historic: historicTeacherIds(data).size,
    };
}
