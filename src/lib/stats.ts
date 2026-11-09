// Shared statistics (30 Sep 2026). ONE place for every number the portal shows about
// courses, students, attendance and volunteers, so every page agrees. Pure functions over
// plain arrays: nothing here reads Firestore (see src/lib/statsLoader.ts for loading).
//
// DEFINITIONS (plain English)
//
// Spelling
//   - Status: compared in lower case with spaces trimmed ("Running", "running " are the same).
//   - Type: "Rolling Course" and "rolling" are "Rolling"; "drop-in" and "Drop In" are
//     "Drop-in"; "1-2-1" stays "1-2-1"; a course with no type is "Rolling".
//   - A course is RUNNING when its status is "running", FINISHED when "completed" or "cancelled".
//
// Orphans (left behind by old deletes) are ignored everywhere:
//   - roster rows whose course or student no longer exists,
//   - assignments whose course or user no longer exists,
//   - attendance rows whose course no longer exists.
//
// Archived students and people (archived === true, see src/lib/archive.ts)
//   - are LEFT OUT of current counts: enrolled now, students on a course now, active
//     volunteers now, teachers now;
//   - are KEPT in historical totals: attendance, sessions, hours delivered.
//
// Session (a class held) of a course: a distinct date with at least one attendance record for
//   that course, a student tick or a teacher tick. Not class reports, not the schedule.
// Students on a course: distinct, existing, non-archived students on its roster.
// Enrolled now: distinct students on the roster of at least one running course.
// Teachers of a course: distinct, existing, non-archived users assigned to it, any role
//   (admins included).
// Course length in hours: schedule end minus start ("HH:MM"), 0 when missing. Never a
//   1 hour default.
// Hours delivered by a course: sessions x course length; a 1-2-1 course adds up the
//   minutes of its logged sessions instead.
// Classes taught by a person: distinct (course, date) pairs among attendance records with
//   that person's userId, plus each of their 1-2-1 sessions counted once. This is the
//   server's badge rule (awardBadgesFor in functions/index.js).
// Volunteer hours: for each distinct class taught, the course length; plus 1-2-1 minutes / 60;
//   plus approved "Log Hours" requests (volunteerActivities, status "approved", field hours).
//   No caps. Equal to the badge rule, except that registers of deleted courses are ignored
//   here (they add 0 hours on the server too, but the server still counts the class).
// Active volunteer (now): a non-archived user whose role is "volunteer" OR who has taught at
//   least once (a distinct class, an assignment on a running course, or a 1-2-1 session),
//   any role, admins included.
// Active volunteer in a period: an existing user who taught at least once in the period, or
//   has approved hours dated in the period. Archived people count here: this is history.
// Learner hours (Funders): for each attendance record of a student, counted once per
//   student per course per day, the course length.
// Attendance rate of a course: the agreed fair method in src/lib/attendanceRates.ts.
// Attendance headline: the AVERAGE of the course rates of the chosen courses; courses with
//   no rate are left out. Default courses: Rolling and running. The Funders Report uses all
//   Rolling courses (running and finished).
// Date range {from?, to?} ('YYYY-MM-DD', both ends included) filters attendance records,
//   1-2-1 sessions (their date) and approved activities (their date, else createdAt).

import { attendanceByCourse, toDay } from "./attendanceRates";
import type { AttendanceRecord, RosterRecord, CourseAttendance } from "./attendanceRates";

export { attendanceByCourse, toDay };
export type { CourseAttendance };

export type DateRange = { from?: string; to?: string };

export interface SCourse { id: string; code?: string; name?: string; type?: string; status?: string; schedule?: { start?: string; end?: string; day?: string;[k: string]: any } | null;[k: string]: any }
export interface SStudent { id: string; archived?: boolean; createdAt?: any;[k: string]: any }
export interface SUser { id: string; role?: string; archived?: boolean;[k: string]: any }
export interface SRoster { courseId?: string; studentId?: string; enrolledAt?: any;[k: string]: any }
export interface SAssignment { courseId?: string; volunteerId?: string;[k: string]: any }
export interface SAttendance { courseId?: string; date?: string; studentId?: string; userId?: string;[k: string]: any }
export interface SOneToOne { courseId?: string; studentId?: string; volunteerId?: string; date?: any; durationMinutes?: any;[k: string]: any }
export interface SActivity { volunteerId?: string; hours?: any; status?: string; date?: any; createdAt?: any;[k: string]: any }

/** Everything a calculation may need. Leave out students/users when they were not loaded:
 *  the existence and archive checks for them are then skipped. */
export interface StatsData {
    courses: SCourse[];
    students?: SStudent[];
    users?: SUser[];
    roster?: SRoster[];
    assignments?: SAssignment[];
    attendance?: SAttendance[];
    oneToOne?: SOneToOne[];
    activities?: SActivity[];
}

// ---------------------------------------------------------------- spelling

export function normStatus(s: unknown): string {
    return String(s ?? "").trim().toLowerCase();
}

export function normType(t: unknown): string {
    const raw = String(t ?? "").trim();
    if (!raw) return "Rolling";
    const k = raw.toLowerCase().replace(/\s+/g, " ");
    if (k === "rolling" || k === "rolling course") return "Rolling";
    if (k === "drop-in" || k === "drop in" || k === "dropin") return "Drop-in";
    if (k === "1-2-1") return "1-2-1";
    return raw;
}

export function normRole(r: unknown): string {
    return String(r ?? "").trim().toLowerCase();
}

export const isRunning = (c: { status?: unknown } | null | undefined) => normStatus(c?.status) === "running";
export const isFinished = (c: { status?: unknown } | null | undefined) => { const s = normStatus(c?.status); return s === "completed" || s === "cancelled"; };
export const isRolling = (c: { type?: unknown } | null | undefined) => normType(c?.type) === "Rolling";
export const isDropIn = (c: { type?: unknown } | null | undefined) => normType(c?.type) === "Drop-in";
export const isOneToOne = (c: { type?: unknown } | null | undefined) => normType(c?.type) === "1-2-1";
export const isArchived = (x: { archived?: unknown } | null | undefined) => x?.archived === true;

/** Course length in hours from schedule "HH:MM" times; 0 when missing (same as the server). */
export function courseLengthHours(course: SCourse | null | undefined): number {
    const s = course && course.schedule;
    if (!s || !s.start || !s.end) return 0;
    const [sh, sm] = String(s.start).split(":").map(Number);
    const [eh, em] = String(s.end).split(":").map(Number);
    const d = (eh + (em || 0) / 60) - (sh + (sm || 0) / 60);
    return d > 0 ? d : 0;
}

// ---------------------------------------------------------------- dates

/** True when the day is inside the range (both ends included). No range, or an empty one, lets everything in. */
export function inRange(day: string | undefined, range?: DateRange): boolean {
    if (!range || (!range.from && !range.to)) return true;
    if (!day) return false;
    if (range.from && day < range.from) return false;
    if (range.to && day > range.to) return false;
    return true;
}

export const activityDay = (a: SActivity) => toDay(a.date) || toDay(a.createdAt);

/** Today as YYYY-MM-DD in local time. */
export function todayStr(now: Date = new Date()): string {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Last 12 months up to today. */
export function last12Months(now: Date = new Date()): DateRange {
    const from = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate() + 1);
    return { from: todayStr(from), to: todayStr(now) };
}

/** The year that starts on 1 April (financial and leave year) and contains today. */
export function yearFromApril(now: Date = new Date()): DateRange {
    const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    return { from: `${y}-04-01`, to: `${y + 1}-03-31` };
}

// ---------------------------------------------------------------- cleaning

export interface CleanData {
    courseById: Map<string, SCourse>;
    studentById: Map<string, SStudent> | null;
    userById: Map<string, SUser> | null;
    roster: SRoster[];
    assignments: SAssignment[];
    attendance: SAttendance[];
    oneToOne: SOneToOne[];
    /** Approved activities only. */
    activities: SActivity[];
}

/** Drops orphans (see the definitions above) and keeps only approved activities. */
export function cleanData(data: StatsData): CleanData {
    const courseById = new Map((data.courses || []).map(c => [c.id, c]));
    const studentById = data.students ? new Map(data.students.map(s => [s.id, s])) : null;
    const userById = data.users ? new Map(data.users.map(u => [u.id, u])) : null;
    return {
        courseById, studentById, userById,
        roster: (data.roster || []).filter(r => !!r.courseId && !!r.studentId && courseById.has(r.courseId) && (!studentById || studentById.has(r.studentId))),
        assignments: (data.assignments || []).filter(a => !!a.courseId && !!a.volunteerId && courseById.has(a.courseId) && (!userById || userById.has(a.volunteerId))),
        attendance: (data.attendance || []).filter(a => !!a.courseId && !!a.date && courseById.has(a.courseId)),
        oneToOne: data.oneToOne || [],
        activities: (data.activities || []).filter(a => a.status === "approved"),
    };
}

/** Keeps only what belongs to the given courses (and, optionally, drops logged hours, which belong to no course). */
export function restrictToCourses(data: StatsData, courseIds: Iterable<string>, opts: { keepActivities?: boolean } = {}): StatsData {
    const ids = new Set(courseIds);
    return {
        ...data,
        courses: data.courses.filter(c => ids.has(c.id)),
        roster: (data.roster || []).filter(r => !!r.courseId && ids.has(r.courseId)),
        assignments: (data.assignments || []).filter(a => !!a.courseId && ids.has(a.courseId)),
        attendance: (data.attendance || []).filter(a => !!a.courseId && ids.has(a.courseId)),
        oneToOne: (data.oneToOne || []).filter(o => !!o.courseId && ids.has(o.courseId)),
        activities: opts.keepActivities ? data.activities : [],
    };
}

// ---------------------------------------------------------------- courses

/** Sorted distinct dates on which each course held a class (any attendance record). */
export function sessionDatesByCourse(data: StatsData, range?: DateRange): Record<string, string[]> {
    const c = cleanData(data);
    const sets: Record<string, Set<string>> = {};
    c.attendance.forEach(a => { if (inRange(a.date, range)) (sets[a.courseId!] ||= new Set()).add(a.date!); });
    const out: Record<string, string[]> = {};
    Object.entries(sets).forEach(([k, v]) => { out[k] = [...v].sort(); });
    return out;
}

export function sessionsByCourse(data: StatsData, range?: DateRange): Record<string, number> {
    const out: Record<string, number> = {};
    Object.entries(sessionDatesByCourse(data, range)).forEach(([k, v]) => { out[k] = v.length; });
    return out;
}

/** Distinct existing, non-archived students on each course's roster. */
export function studentsByCourse(data: StatsData): Record<string, string[]> {
    const c = cleanData(data);
    const sets: Record<string, Set<string>> = {};
    c.roster.forEach(r => {
        const s = c.studentById?.get(r.studentId!);
        if (s && isArchived(s)) return;
        (sets[r.courseId!] ||= new Set()).add(r.studentId!);
    });
    const out: Record<string, string[]> = {};
    Object.entries(sets).forEach(([k, v]) => { out[k] = [...v]; });
    return out;
}

export function studentsOnCourse(courseId: string, data: StatsData): string[] {
    return studentsByCourse(data)[courseId] || [];
}

/** Distinct non-archived students on the roster of at least one running course. */
export function enrolledNow(data: StatsData): string[] {
    const by = studentsByCourse(data);
    const out = new Set<string>();
    data.courses.filter(isRunning).forEach(c => (by[c.id] || []).forEach(s => out.add(s)));
    return [...out];
}

/** Distinct existing, non-archived users assigned to each course, any role. */
export function teachersByCourse(data: StatsData): Record<string, string[]> {
    const c = cleanData(data);
    const sets: Record<string, Set<string>> = {};
    c.assignments.forEach(a => {
        const u = c.userById?.get(a.volunteerId!);
        if (u && isArchived(u)) return;
        (sets[a.courseId!] ||= new Set()).add(a.volunteerId!);
    });
    const out: Record<string, string[]> = {};
    Object.entries(sets).forEach(([k, v]) => { out[k] = [...v]; });
    return out;
}

export function teachersOfCourse(courseId: string, data: StatsData): string[] {
    return teachersByCourse(data)[courseId] || [];
}

/** 1-2-1 sessions logged against each course: how many, and their hours. */
export function oneToOneByCourse(data: StatsData, range?: DateRange): Record<string, { sessions: number; hours: number }> {
    const out: Record<string, { sessions: number; hours: number }> = {};
    (data.oneToOne || []).forEach(o => {
        if (!o.courseId || !inRange(toDay(o.date), range)) return;
        const x = (out[o.courseId] ||= { sessions: 0, hours: 0 });
        x.sessions++;
        x.hours += (Number(o.durationMinutes) || 0) / 60;
    });
    return out;
}

export interface CourseFigures {
    sessions: number;       // classes held (1-2-1 course: sessions logged)
    hours: number;          // sessions x course length (1-2-1: logged minutes / 60)
    students: number;       // students on the course now
    teachers: number;       // teachers on the course now
    lengthHours: number;
}

/** Sessions, hours delivered, students and teachers for every course. */
export function courseFigures(data: StatsData, range?: DateRange): Record<string, CourseFigures> {
    const sessions = sessionsByCourse(data, range);
    const students = studentsByCourse(data);
    const teachers = teachersByCourse(data);
    const one = oneToOneByCourse(data, range);
    const out: Record<string, CourseFigures> = {};
    data.courses.forEach(c => {
        const len = courseLengthHours(c);
        const o = one[c.id];
        const oneToOne = isOneToOne(c);
        const s = oneToOne ? (o?.sessions || 0) : (sessions[c.id] || 0);
        out[c.id] = {
            sessions: s,
            hours: oneToOne ? (o?.hours || 0) : s * len,
            students: (students[c.id] || []).length,
            teachers: (teachers[c.id] || []).length,
            lengthHours: len,
        };
    });
    return out;
}

// ---------------------------------------------------------------- attendance

/** studentId -> day the student record was created (used by the fair method for students who never came). */
export function joinedFallback(students: SStudent[] | undefined): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    (students || []).forEach(s => { out[s.id] = toDay(s.createdAt); });
    return out;
}

/** Fair attendance of every course (src/lib/attendanceRates.ts), orphans left out, archived students kept. */
export function courseAttendance(data: StatsData, range?: DateRange): Record<string, CourseAttendance> {
    const c = cleanData(data);
    const records = c.attendance.filter(a => inRange(a.date, range)) as AttendanceRecord[];
    const roster = c.roster.map(r => ({ courseId: r.courseId, studentId: r.studentId, enrolledAt: toDay(r.enrolledAt) })) as RosterRecord[];
    return attendanceByCourse(records, roster, joinedFallback(data.students));
}

export interface AttendanceHeadline { rate: number | null; present: number; expected: number; courses: number }

/** Average of the course rates of the chosen courses (no rate = left out), with the sums of the same courses. */
export function attendanceHeadline(perCourse: Record<string, CourseAttendance>, courseIds: Iterable<string>): AttendanceHeadline {
    let sum = 0, n = 0, present = 0, expected = 0;
    new Set(courseIds).forEach(id => {
        const a = perCourse[id];
        if (!a || a.rate === null) return;
        sum += a.rate; n++; present += a.present; expected += a.expected;
    });
    return { rate: n > 0 ? Math.round(sum / n) : null, present, expected, courses: n };
}

/** Default courses for attendance headlines: Rolling and running. */
export function defaultHeadlineCourseIds(courses: SCourse[]): string[] {
    return courses.filter(c => isRolling(c) && isRunning(c)).map(c => c.id);
}

/** Funders Report: every Rolling course, running or finished. */
export function allRollingCourseIds(courses: SCourse[]): string[] {
    return courses.filter(isRolling).map(c => c.id);
}

/**
 * The part of a course a student belongs to, by the same "attendance span" rule as
 * attendanceRates.ts: from their first register (or enrolment, when earlier) to their last
 * register, or to the latest register when still on the roster. A student on the roster who
 * never came counts from enrolment (or record creation), not before the first register.
 * null when the student is not counted on this course at all.
 */
export function studentCourseSpan(studentId: string, courseId: string, data: StatsData, range?: DateRange): { from: string; to: string } | null {
    const c = cleanData(data);
    const recs = c.attendance.filter(a => a.courseId === courseId && inRange(a.date, range));
    const days = [...new Set(recs.map(a => a.date!))].sort();
    if (days.length === 0) return null;
    const latest = days[days.length - 1];
    const mine = [...new Set(recs.filter(a => a.studentId === studentId).map(a => a.date!))].sort();
    const rows = c.roster.filter(r => r.courseId === courseId && r.studentId === studentId);
    let enrolled: string | undefined;
    rows.forEach(r => { const e = toDay(r.enrolledAt); if (e && (!enrolled || e < enrolled)) enrolled = e; });
    if (mine.length > 0) {
        let from = mine[0], to = mine[mine.length - 1];
        if (rows.length > 0) { to = latest; if (enrolled && enrolled < from) from = enrolled; }
        return { from, to };
    }
    if (rows.length === 0) return null;
    const joined = enrolled || joinedFallback(data.students)[studentId];
    if (!joined) return null;
    const from = joined < days[0] ? days[0] : joined;
    return from <= latest ? { from, to: latest } : null;
}

export interface StudentCourseAttendance { attended: number; of: number; rate: number | null }

/** One student's classes on one course: attended X of Y (Y = classes held within their span), by the fair method itself. */
export function studentCourseAttendance(studentId: string, courseId: string, data: StatsData, range?: DateRange): StudentCourseAttendance {
    const c = cleanData(data);
    // Other students' ticks keep their dates (a class was held) but lose the student id.
    const records = c.attendance
        .filter(a => a.courseId === courseId && inRange(a.date, range))
        .map(a => (a.studentId === studentId ? { courseId, date: a.date, studentId } : { courseId, date: a.date })) as AttendanceRecord[];
    const roster = c.roster.filter(r => r.courseId === courseId && r.studentId === studentId)
        .map(r => ({ courseId, studentId, enrolledAt: toDay(r.enrolledAt) })) as RosterRecord[];
    const res = attendanceByCourse(records, roster, { [studentId]: joinedFallback(data.students)[studentId] })[courseId];
    return res ? { attended: res.present, of: res.expected, rate: res.rate } : { attended: 0, of: 0, rate: null };
}

/** Learner hours of each course: each student counted once per course per day, times the course length. */
export function learnerHoursByCourse(data: StatsData, range?: DateRange): Record<string, number> {
    const c = cleanData(data);
    const seen = new Set<string>();
    const out: Record<string, number> = {};
    c.attendance.forEach(a => {
        if (!a.studentId || !inRange(a.date, range)) return;
        const key = `${a.studentId}|${a.courseId}|${a.date}`;
        if (seen.has(key)) return;
        seen.add(key);
        out[a.courseId!] = (out[a.courseId!] || 0) + courseLengthHours(c.courseById.get(a.courseId!));
    });
    return out;
}

export function learnerHours(data: StatsData, range?: DateRange): number {
    return Object.values(learnerHoursByCourse(data, range)).reduce((t, h) => t + h, 0);
}

/** Distinct students with at least one tick on each course (in the range). */
export function learnersByCourse(data: StatsData, range?: DateRange): Record<string, number> {
    const c = cleanData(data);
    const sets: Record<string, Set<string>> = {};
    c.attendance.forEach(a => { if (a.studentId && inRange(a.date, range)) (sets[a.courseId!] ||= new Set()).add(a.studentId); });
    const out: Record<string, number> = {};
    Object.entries(sets).forEach(([k, v]) => { out[k] = v.size; });
    return out;
}

// ---------------------------------------------------------------- volunteers

export interface VolunteerHours {
    classes: number;          // distinct classes taught + 1-2-1 sessions (the badge "classCount")
    classSessions: number;    // distinct classes taught from registers
    oneToOneSessions: number;
    classHours: number;
    oneToOneHours: number;
    otherHours: number;       // approved "Log Hours" requests
    total: number;
    lastClass: string;        // latest class or 1-2-1 date ('' when none)
}

const emptyHours = (): VolunteerHours => ({ classes: 0, classSessions: 0, oneToOneSessions: 0, classHours: 0, oneToOneHours: 0, otherHours: 0, total: 0, lastClass: "" });

/** Volunteer hours of every person who taught or logged approved hours. */
export function volunteerHoursByPerson(data: StatsData, range?: DateRange): Record<string, VolunteerHours> {
    const c = cleanData(data);
    const out: Record<string, VolunteerHours> = {};
    const get = (uid: string) => (out[uid] ||= emptyHours());
    const seen = new Set<string>();
    c.attendance.forEach(a => {
        if (!a.userId || !inRange(a.date, range)) return;
        const key = `${a.userId}|${a.courseId}|${a.date}`;
        if (seen.has(key)) return;
        seen.add(key);
        const h = get(a.userId);
        h.classSessions++;
        h.classHours += courseLengthHours(c.courseById.get(a.courseId!));
        if (a.date! > h.lastClass) h.lastClass = a.date!;
    });
    c.oneToOne.forEach(o => {
        const day = toDay(o.date);
        if (!o.volunteerId || !inRange(day, range)) return;
        const h = get(o.volunteerId);
        h.oneToOneSessions++;
        h.oneToOneHours += (Number(o.durationMinutes) || 0) / 60;
        if (day && day > h.lastClass) h.lastClass = day;
    });
    c.activities.forEach(a => {
        if (!a.volunteerId || !inRange(activityDay(a), range)) return;
        get(a.volunteerId).otherHours += Number(a.hours) || 0;
    });
    Object.values(out).forEach(h => {
        h.classes = h.classSessions + h.oneToOneSessions;
        h.total = h.classHours + h.oneToOneHours + h.otherHours;
    });
    return out;
}

export function volunteerHours(uid: string, data: StatsData, range?: DateRange): VolunteerHours {
    return volunteerHoursByPerson(data, range)[uid] || emptyHours();
}

/** People who have ever taught: a distinct class, an assignment on a running course, or a 1-2-1 session. Any role. */
export function teachingPeople(data: StatsData): Set<string> {
    const c = cleanData(data);
    const out = new Set<string>();
    c.attendance.forEach(a => { if (a.userId) out.add(a.userId); });
    c.assignments.forEach(a => { if (isRunning(c.courseById.get(a.courseId!))) out.add(a.volunteerId!); });
    c.oneToOne.forEach(o => { if (o.volunteerId) out.add(o.volunteerId); });
    return out;
}

/** The Volunteers list rule, archive aside: the volunteer role, or has taught. */
export function isVolunteerOrTeacher(user: SUser, teaching: Set<string>): boolean {
    return normRole(user.role) === "volunteer" || teaching.has(user.id);
}

/**
 * Active volunteers. Without a range: now (non-archived, volunteer role or has taught).
 * With a range (even an empty one, meaning all time): taught at least once in the range or
 * has approved hours dated in it; archived people are included, as this is history.
 */
export function activeVolunteerIds(data: StatsData, range?: DateRange): Set<string> {
    const users = data.users || [];
    if (range === undefined) {
        const teaching = teachingPeople(data);
        return new Set(users.filter(u => !isArchived(u) && isVolunteerOrTeacher(u, teaching)).map(u => u.id));
    }
    const hours = volunteerHoursByPerson(data, range);
    return new Set(users.filter(u => { const h = hours[u.id]; return !!h && (h.classes > 0 || h.otherHours > 0); }).map(u => u.id));
}

/** Rounds to one decimal place for display. */
export const round1 = (n: number) => Math.round(n * 10) / 10;
