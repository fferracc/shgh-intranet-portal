// Badges (30 Sep 2026). ONE place in the portal for how a badge is earned, so the Badges page,
// My Profile and the volunteer page agree with the server. The server does the awarding
// (functions/index.js, BADGES section) and the UK app has a copy of these rules: keep all three
// in step. Pure functions: nothing here reads Firestore.
//
// Badge types (achievementsBadges.type) with a target (goal):
//   classCount       classes taught: distinct (course, date) teacher ticks in the registers of
//                    courses that still exist, plus every 1-2-1 session (the "Classes Taught"
//                    figure of src/lib/stats.ts)
//   hours            hours volunteered: each of those classes = the course's timetable length,
//                    plus 1-2-1 minutes / 60, plus approved "Log Hours" requests (the
//                    "Volunteer Hours" figure of src/lib/stats.ts)
//   monthsOfService  whole months from the person's first class, 1-2-1 session or approved
//                    activity to today
//   coursesTaught    distinct courses with at least one teacher tick or 1-2-1 session
//   "Manual" or no type: awarded by hand only.
// The date a badge was earned is the day the target was actually reached (reachedOn).

import { activityDay, courseLengthHours, toDay } from "./stats";
import type { SActivity, SAttendance, SCourse, SOneToOne } from "./stats";
import type { Badge, EarnedBadge } from "./types";

export const AUTO_BADGE_TYPES = ["classCount", "hours", "monthsOfService", "coursesTaught"] as const;
export type AutoBadgeType = typeof AUTO_BADGE_TYPES[number];

export const BADGE_TYPE_OPTIONS: { value: AutoBadgeType | "Manual"; label: string; help: string }[] = [
    { value: "classCount", label: "Classes taught", help: "Each class a person ticked themselves in as teacher counts once per course per day. Every 1-2-1 session counts as one class." },
    { value: "hours", label: "Hours volunteered", help: "Each class taught counts the length of the course timetable. 1-2-1 sessions count their logged minutes. Approved Log Hours requests are added." },
    { value: "monthsOfService", label: "Months of service", help: "Whole months from the person's first class, 1-2-1 session or approved hours to today. Checked every night." },
    { value: "coursesTaught", label: "Courses taught", help: "Different courses where the person was ticked in as teacher at least once or ran a 1-2-1 session." },
    { value: "Manual", label: "By hand only", help: "Never given automatically. Someone with the Badges permission awards it with Award by hand." },
];

export function isAutoType(type: unknown): type is AutoBadgeType {
    return (AUTO_BADGE_TYPES as readonly string[]).includes(String(type));
}
/** A badge the server gives by itself: an automatic type with a target above 0. */
export function isAutoBadge(b: Pick<Badge, "type" | "goal"> | null | undefined): boolean {
    return !!b && isAutoType(b.type) && (Number(b.goal) || 0) > 0;
}
export function badgeTypeLabel(type: unknown): string {
    return BADGE_TYPE_OPTIONS.find(o => o.value === type && isAutoType(type))?.label || "By hand only";
}
/** "25 classes", "1 hour", "6 months", "3 courses". */
export function badgeAmount(type: unknown, n: number): string {
    const v = type === "hours" ? Math.round(n * 10) / 10 : Math.floor(n);
    const one = v === 1;
    const word = type === "classCount" ? (one ? "class" : "classes")
        : type === "hours" ? (one ? "hour" : "hours")
        : type === "monthsOfService" ? (one ? "month" : "months")
        : type === "coursesTaught" ? (one ? "course" : "courses") : "";
    return `${v} ${word}`.trim();
}
/** "18 of 25 classes". */
export function progressText(c: BadgeCheck): string {
    const cur = c.type === "hours" ? Math.round(c.current * 10) / 10 : Math.floor(c.current);
    return `${cur} of ${badgeAmount(c.type, c.goal)}`;
}

// ---------------------------------------------------------------- dates

/** Today in the UK as 'YYYY-MM-DD'. */
export function londonToday(now: Date = new Date()): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(now);
}
const validDay = (d: unknown): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);

/** 'YYYY-MM-DD' + n months; the day is kept, or the last day of a shorter month (31 Jan + 1 = 28 Feb). */
export function addMonthsDay(day: string, n: number): string {
    const [y, m, d] = day.split("-").map(Number);
    const total = (m - 1) + n;
    const ny = y + Math.floor(total / 12);
    const nm = ((total % 12) + 12) % 12;
    const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
    return `${ny}-${String(nm + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}
/** Whole months from `from` to `to`: the largest n with from + n months on or before `to`. */
export function wholeMonthsBetween(from: string, to: string): number {
    if (!validDay(from) || !validDay(to) || to < from) return 0;
    const [fy, fm] = from.split("-").map(Number);
    const [ty, tm] = to.split("-").map(Number);
    let n = (ty - fy) * 12 + (tm - fm);
    while (n > 0 && addMonthsDay(from, n) > to) n--;
    return Math.max(0, n);
}
/** 'YYYY-MM-DD' -> '5 Jan 2026'. */
export function ukDate(day: string | undefined): string {
    if (!validDay(day)) return "";
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
}

// ---------------------------------------------------------------- events and checks

export interface BadgeEvent { day: string; classes: number; hours: number; courseId: string }

export interface BadgeRows {
    courses: SCourse[];
    attendance?: SAttendance[];
    oneToOne?: SOneToOne[];
    activities?: SActivity[];
}

/** One person's dated events, oldest first (undated ones last). Same as the server's badgeEvents. */
export function badgeEvents(uid: string, rows: BadgeRows): BadgeEvent[] {
    const courseById = new Map((rows.courses || []).map(c => [c.id, c]));
    const events: BadgeEvent[] = [];
    const seen = new Set<string>();
    (rows.attendance || []).forEach(a => {
        if (!a || a.userId !== uid || !a.courseId || !a.date || !courseById.has(a.courseId)) return;
        const key = `${a.courseId}|${a.date}`;
        if (seen.has(key)) return;
        seen.add(key);
        events.push({ day: String(a.date).slice(0, 10), classes: 1, hours: courseLengthHours(courseById.get(a.courseId)), courseId: a.courseId });
    });
    (rows.oneToOne || []).forEach(o => {
        if (!o || o.volunteerId !== uid) return;
        events.push({ day: toDay(o.date) || "", classes: 1, hours: (Number(o.durationMinutes) || 0) / 60, courseId: o.courseId || "" });
    });
    (rows.activities || []).forEach(a => {
        if (!a || a.volunteerId !== uid || a.status !== "approved") return;
        events.push({ day: activityDay(a) || "", classes: 0, hours: Number(a.hours) || 0, courseId: "" });
    });
    events.forEach(e => { if (!validDay(e.day)) e.day = ""; });
    events.sort((x, y) => (x.day === y.day ? 0 : !x.day ? 1 : !y.day ? -1 : x.day < y.day ? -1 : 1));
    return events;
}

export interface BadgeCheck {
    type: AutoBadgeType;
    goal: number;
    current: number;
    reached: boolean;
    /** The day the target was reached ('' when not reached). */
    reachedOn: string;
    value: number;
}

/** Where a person stands on one automatic badge; null for a badge awarded by hand only. */
export function badgeCheck(badge: Pick<Badge, "type" | "goal">, events: BadgeEvent[], today: string = londonToday()): BadgeCheck | null {
    const type = badge?.type;
    const goal = Number(badge?.goal) || 0;
    if (!isAutoType(type) || goal <= 0) return null;
    const clamp = (d: string) => (!d || d > today ? today : d);
    if (type === "monthsOfService") {
        const first = events.find(e => e.day);
        const start = first ? first.day : "";
        const current = start ? wholeMonthsBetween(start, today) : 0;
        const reached = current >= goal;
        return { type, goal, current, reached, reachedOn: reached ? clamp(addMonthsDay(start, goal)) : "", value: reached ? goal : current };
    }
    let current = 0;
    let reachedOn = "";
    let value = 0;
    const courses = new Set<string>();
    for (const e of events) {
        if (type === "classCount") current += e.classes;
        else if (type === "hours") current += e.hours;
        else {
            if (!e.classes || !e.courseId || courses.has(e.courseId)) continue;
            courses.add(e.courseId);
            current = courses.size;
        }
        if (!reachedOn && current >= goal - 1e-9) { reachedOn = clamp(e.day); value = current; }
    }
    if (type === "hours") { current = Math.round(current * 10) / 10; value = Math.round(value * 10) / 10; }
    return { type, goal, current, reached: !!reachedOn, reachedOn, value };
}

/**
 * The automatic badge the person is closest to (highest share of its target) among the
 * badges they do not have yet. Archived badges are left out. A badge whose target is already
 * reached but not yet added by the server comes first (reached: true).
 */
export function nextBadge(badges: Badge[], earnedBadgeIds: Set<string>, events: BadgeEvent[], today: string = londonToday()): { badge: Badge; check: BadgeCheck } | null {
    let best: { badge: Badge; check: BadgeCheck; share: number } | null = null;
    for (const b of badges) {
        if (b.archived === true || earnedBadgeIds.has(b.id)) continue;
        const check = badgeCheck(b, events, today);
        if (!check) continue;
        const share = check.current / check.goal;
        if (!best || share > best.share || (share === best.share && check.goal < best.check.goal)) best = { badge: b, check, share };
    }
    return best ? { badge: best.badge, check: best.check } : null;
}

// ---------------------------------------------------------------- earned badges

/** The day a badge was earned: reachedOn, else the award time. */
export function earnedDay(e: Pick<EarnedBadge, "reachedOn" | "earnedAt">): string {
    if (validDay(e.reachedOn)) return e.reachedOn;
    return toDay(e.earnedAt) || "";
}
/** Only awards made by hand through awardBadgeByHand. Older awards cannot be told apart. */
export function isHandAward(e: Pick<EarnedBadge, "manual"> | null | undefined): boolean {
    return !!e && e.manual === true;
}
/** "Awarded by Jane Smith" for a hand award, '' otherwise. */
export function awardedByLabel(e: Pick<EarnedBadge, "manual" | "awardedByName">): string {
    return isHandAward(e) ? `Awarded by ${e.awardedByName || "a member of staff"}` : "";
}
