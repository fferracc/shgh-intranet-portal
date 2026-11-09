// Registers (30 Sep 2026, Franco). Shared helpers for Class Reports, the course page and the
// Historic Registers page. Pure functions: nothing here reads or writes Firestore.
//
// RULES (mirroring firestore.rules, attendanceRecords and classRecords)
//   - A register can be TAKEN for any date by a volunteer, staff, admin or super admin.
//   - It can be CHANGED (untick, delete) only on the class date, UK time; after that only the
//     super admin. A late tick on the day is a new record, so it is always allowed that day.
//   - A record { courseId, date, held: true } with no studentId/userId means "class held,
//     nobody came". It makes the date a session like any other record.
//
// THE GRID uses the same "attendance span" rule as attendanceByCourse (attendanceRates.ts):
//   - a student belongs from their first register, or their enrolment date when earlier;
//   - if still on the roster, to the latest register of the course (missed classes count);
//   - if no longer on the roster, to their last register (cells after it are "left");
//   - a roster student who never came belongs from their enrolment date (or the day their
//     student record was created), never before the first register.
// Cells outside the span are "not_enrolled" (before) or "left" (after).

import { attendanceByCourse, toDay } from "./attendanceRates";
import type { AttendanceRecord, CourseAttendance, RosterRecord } from "./attendanceRates";
import { courseLengthHours, isArchived } from "./stats";
import type { SAssignment, SAttendance, SCourse, SRoster, SStudent, SUser } from "./stats";

// ---------------------------------------------------------------- dates and permissions

/** Today as 'YYYY-MM-DD' in UK time (Europe/London), whatever the computer's time zone. */
export function londonToday(now: Date = new Date()): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** 'YYYY-MM-DD' to 'dd/mm/yyyy' (as typed, no time zone conversion). */
export function ukDate(day: string | undefined): string {
    if (!day || day.length < 10) return day || "";
    return `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
}

/** 'YYYY-MM-DD' to "Tuesday 30 September" (the date itself, read as a calendar day). */
export function longUkDate(day: string, withYear = false): string {
    const [y, m, d] = day.split("-").map(Number);
    if (!y || !m || !d) return day;
    const dt = new Date(Date.UTC(y, m - 1, d, 12));
    return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", ...(withYear ? { year: "numeric" } : {}) }).format(dt);
}

export interface RegisterUser { uid?: string; role?: string | null }

/** Roles the rules allow to take a register (create attendance records). */
export const REGISTER_ROLES = ["volunteer", "staff", "admin", "super_admin"];

export function canTakeRegister(user: RegisterUser | null | undefined): boolean {
    return !!user && REGISTER_ROLES.includes(String(user.role || ""));
}

/** Can this person change (untick, delete) the register of this date? */
export function canEditRegister(user: RegisterUser | null | undefined, date: string): boolean {
    if (!user) return false;
    if (user.role === "super_admin") return true;
    return date === londonToday() && canTakeRegister(user);
}

/** Can this person edit this class report? The author on the class date, or the super admin. */
export function canEditReport(user: RegisterUser | null | undefined, report: { volunteerId?: string; date?: string }): boolean {
    if (!user) return false;
    if (user.role === "super_admin") return true;
    return !!user.uid && report.volunteerId === user.uid && report.date === londonToday();
}

/** A phone number for wa.me links: digits only, UK numbers with 44 in front. '' when not usable. */
export function ukWhatsAppNumber(raw: unknown): string {
    let d = String(raw ?? "").replace(/\D/g, "");
    if (d.startsWith("00")) d = d.slice(2);                 // 0044 7700 ... (international prefix)
    else if (d.startsWith("0")) d = "44" + d.slice(1);      // 07700 ... becomes 447700 ...
    else if (d.length === 10 && d.startsWith("7")) d = "44" + d; // 7700 ... with the 0 left off
    if (d.startsWith("440")) d = "44" + d.slice(3);         // +44 (0) 7700 ...
    return d.length >= 11 && d.length <= 15 ? d : "";
}

// ---------------------------------------------------------------- the grid

export type RegisterCell = "present" | "absent" | "not_enrolled" | "left";

export interface RegisterStudentRow {
    id: string;
    name: string;
    archived: boolean;
    onRoster: boolean;          // still on the course roster today
    span: { from: string; to: string } | null;
    cells: RegisterCell[];      // one per date in RegisterGrid.dates
    attended: number;
    expected: number;           // classes held within their span
    rate: number | null;        // attended / expected, whole per cent
}

export interface RegisterTeacherRow {
    id: string;
    name: string;
    assigned: boolean;          // assigned to the course now (archived people are not)
    archived: boolean;
    present: boolean[];         // one per date
    classes: number;
}

export interface RegisterGrid {
    courseId: string;
    dates: string[];            // sorted class dates (any record, "nobody came" markers included)
    heldOnlyDates: string[];    // dates with a "nobody came" marker
    students: RegisterStudentRow[];
    teachers: RegisterTeacherRow[];
    presentByDate: number[];    // listed students present, per date
    teachersByDate: { id: string; name: string }[][];
    /** Ticked students whose record no longer exists: counted in the rate, not listed. */
    unlistedStudents: number;
    fair: CourseAttendance | null;
    lengthHours: number;
    learnerHours: number;       // student attendances (once per student per day) x course length
    teacherHours: number;       // teacher attendances (once per person per day) x course length
}

export function personName(u: { name?: unknown; displayName?: unknown; email?: unknown;[k: string]: any } | null | undefined): string {
    if (!u) return "";
    return String(u.name || u.displayName || u.email || "").trim();
}

/**
 * The full register of one course.
 * @param students all students (or at least those of this course); ticks of students that are
 *        not in the list are counted in the rate but get no row.
 * @param users all users (or at least the teachers of this course), for names and archive state.
 * @param assignments optional course assignments, so assigned teachers who never ticked are listed.
 */
export function buildRegisterGrid(
    course: SCourse,
    rosterRows: SRoster[],
    students: SStudent[],
    attendance: SAttendance[],
    users: SUser[],
    assignments: SAssignment[] = [],
): RegisterGrid {
    const cid = course.id;
    const studentById = new Map(students.map(s => [s.id, s]));
    const userById = new Map(users.map(u => [u.id, u]));
    const recs = attendance.filter(a => a.courseId === cid && typeof a.date === "string" && a.date.length >= 10);
    const roster = rosterRows.filter(r => r.courseId === cid && !!r.studentId && studentById.has(r.studentId));

    const dates = [...new Set(recs.map(a => a.date!))].sort();
    const latest = dates[dates.length - 1];
    const heldOnly = new Set<string>();
    const studentDays = new Map<string, Set<string>>();
    const teacherDays = new Map<string, Set<string>>();
    recs.forEach(a => {
        if (a.studentId) (studentDays.get(a.studentId) || studentDays.set(a.studentId, new Set()).get(a.studentId)!).add(a.date!);
        else if (a.userId) (teacherDays.get(a.userId) || teacherDays.set(a.userId, new Set()).get(a.userId)!).add(a.date!);
        else if (a.held === true) heldOnly.add(a.date!);
    });

    // Earliest enrolment date per roster student.
    const enrolledOf = new Map<string, string | undefined>();
    roster.forEach(r => {
        const e = toDay(r.enrolledAt);
        const prev = enrolledOf.get(r.studentId!);
        enrolledOf.set(r.studentId!, prev && e ? (prev < e ? prev : e) : (prev || e));
    });

    // Students: everyone on the roster plus everyone ticked, if their record exists.
    const ids = new Set<string>([...enrolledOf.keys(), ...[...studentDays.keys()].filter(id => studentById.has(id))]);
    const rows: RegisterStudentRow[] = [];
    ids.forEach(id => {
        const s = studentById.get(id)!;
        const onRoster = enrolledOf.has(id);
        const mine = [...(studentDays.get(id) || [])].sort();
        let span: { from: string; to: string } | null = null;
        if (latest) {
            if (mine.length > 0) {
                let from = mine[0];
                let to = mine[mine.length - 1];
                if (onRoster) { to = latest; const e = enrolledOf.get(id); if (e && e < from) from = e; }
                span = { from, to };
            } else if (onRoster) {
                const joined = enrolledOf.get(id) || toDay(s.createdAt);
                if (joined) {
                    const from = joined < dates[0] ? dates[0] : joined;
                    if (from <= latest) span = { from, to: latest };
                }
            }
        }
        const present = studentDays.get(id) || new Set<string>();
        let attended = 0, expected = 0;
        const cells: RegisterCell[] = dates.map(d => {
            const inSpan = !!span && span.from <= d && d <= span.to;
            if (inSpan) expected++;
            if (present.has(d)) { attended++; return "present"; }
            if (inSpan) return "absent";
            if (span && d > span.to) return "left";
            return "not_enrolled";
        });
        rows.push({
            id, name: String(s.name || "").trim() || "Unnamed student", archived: isArchived(s), onRoster, span, cells,
            attended, expected, rate: expected > 0 ? Math.round((attended / expected) * 100) : null,
        });
    });
    rows.sort((a, b) => a.name.localeCompare(b.name, "en-GB"));

    // Teachers: assigned (not archived) plus anyone who ticked in.
    const assignedIds = new Set(assignments.filter(a => a.courseId === cid && a.volunteerId).map(a => a.volunteerId!)
        .filter(id => { const u = userById.get(id); return !!u && !isArchived(u); }));
    const teacherIds = new Set<string>([...assignedIds, ...teacherDays.keys()]);
    const teachers: RegisterTeacherRow[] = [...teacherIds].map(id => {
        const u = userById.get(id);
        const days = teacherDays.get(id) || new Set<string>();
        return {
            id, name: personName(u) || "Unknown person", assigned: assignedIds.has(id), archived: isArchived(u),
            present: dates.map(d => days.has(d)), classes: days.size,
        };
    }).sort((a, b) => a.name.localeCompare(b.name, "en-GB"));

    const presentByDate = dates.map((_, i) => rows.reduce((t, r) => t + (r.cells[i] === "present" ? 1 : 0), 0));
    const teachersByDate = dates.map((_, i) => teachers.filter(t => t.present[i]).map(t => ({ id: t.id, name: t.name })));
    const unlistedStudents = [...studentDays.keys()].filter(id => !studentById.has(id)).length;

    // The fair course rate, exactly as src/lib/stats.ts courseAttendance works it out.
    const fallback: Record<string, string | undefined> = {};
    students.forEach(s => { fallback[s.id] = toDay(s.createdAt); });
    const rosterRecs = roster.map(r => ({ courseId: cid, studentId: r.studentId, enrolledAt: toDay(r.enrolledAt) })) as RosterRecord[];
    const fair = attendanceByCourse(recs as AttendanceRecord[], rosterRecs, fallback)[cid] || null;

    const lengthHours = courseLengthHours(course);
    let teacherAttendances = 0;
    teacherDays.forEach(days => { teacherAttendances += days.size; });
    return {
        courseId: cid, dates, heldOnlyDates: dates.filter(d => heldOnly.has(d)),
        students: rows, teachers, presentByDate, teachersByDate, unlistedStudents, fair,
        lengthHours,
        learnerHours: (fair ? fair.present : 0) * lengthHours,
        teacherHours: teacherAttendances * lengthHours,
    };
}

/** Short text for a cell: P, A, "left" or blank. */
export function cellText(c: RegisterCell): string {
    return c === "present" ? "P" : c === "absent" ? "A" : c === "left" ? "left" : "";
}
