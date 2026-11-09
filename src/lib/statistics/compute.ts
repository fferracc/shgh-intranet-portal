// Master Statistics (30 Sep 2026, Franco): every figure of every section, as plain tables.
// Pure: works on what src/lib/statistics/load.ts loaded, reads nothing.
//
// All course, student, attendance and volunteer figures come from the shared rules in
// src/lib/stats.ts (and src/lib/attendanceRates.ts, src/lib/activeVolunteers.ts,
// src/lib/registers.ts, src/lib/policies.ts), so this page agrees with every other page.
// The reporting period and the course filters apply wherever a figure belongs to a date or a
// course; figures for today are marked "now".
import {
    activeVolunteerIds, activityDay, allRollingCourseIds, attendanceHeadline, cleanData, courseAttendance, courseFigures,
    courseLengthHours, defaultHeadlineCourseIds, enrolledNow, inRange, isArchived, isFinished, isOneToOne, isRolling, isRunning,
    learnerHoursByCourse, learnersByCourse, normRole, normStatus, normType, oneToOneByCourse, restrictToCourses, round1,
    teachersByCourse, toDay, todayStr, volunteerHoursByPerson,
    type DateRange, type SCourse, type StatsData,
} from "@/lib/stats";
import { activeInLastDays, historicTeacherIds, registeredVolunteerIds, ACTIVE_DAYS } from "@/lib/activeVolunteers";
import { buildRegisterGrid, type RegisterGrid } from "@/lib/registers";
import { audienceGroup, pct, policyStats, AUDIENCE_LABEL, type PolicyPerson, type ReadMap, type PolicyReadRecord } from "@/lib/policies";
import { isLive } from "@/lib/announcements";
import { appStatusOf } from "@/lib/studentApplicationRules";
import { hasLeaveRole, leaveYearStart } from "@/lib/leaveUtils";
import type { StatsRaw } from "./load";
import type { Cell, CourseStatusFilter, CourseTypeFilter, SectionId, StatKpi, StatSection, StatTable } from "./model";

export interface StatsOptions {
    range: DateRange;
    typeFilter: CourseTypeFilter;
    statusFilter: CourseStatusFilter;
    now?: Date;
}

// ---------------------------------------------------------------- small helpers

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const dayOf = (v: unknown): string | undefined => {
    const d = toDay(v as any);
    return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined;
};
const monthOf = (d?: string) => (d ? d.slice(0, 7) : "");
export const monthLabel = (k: string) => { const [y, m] = k.split("-").map(Number); return y && m ? `${MONTHS_SHORT[m - 1]} ${y}` : k; };
/** Monday = 0 ... Sunday = 6. */
const weekdayOf = (d: string) => { const [y, m, dd] = d.split("-").map(Number); return (new Date(Date.UTC(y, m - 1, dd)).getUTCDay() + 6) % 7; };
const percent = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 100) : null);
const sum = (xs: number[]) => xs.reduce((t, x) => t + x, 0);
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const clean = (v: unknown, missing = "Not recorded") => { const s = String(v ?? "").trim(); return s ? s : missing; };

/** Every month from the period start (or the earliest date) to the period end (or today), at most 120. */
function monthKeys(range: DateRange, days: (string | undefined)[], today: string): string[] {
    const known = days.filter((d): d is string => !!d && /^\d{4}-\d{2}-\d{2}/.test(d)).sort();
    const from = range.from || known[0];
    let to = range.to || today;
    if (to > today) to = today;
    if (!from || from > to) return [];
    const out: string[] = [];
    let [y, m] = from.slice(0, 7).split("-").map(Number);
    const [ty, tm] = to.slice(0, 7).split("-").map(Number);
    while ((y < ty || (y === ty && m <= tm)) && out.length < 240) {
        out.push(`${y}-${String(m).padStart(2, "0")}`);
        m++; if (m > 12) { m = 1; y++; }
    }
    return out.slice(-120);
}

/** Counts by a label, most first, "Not recorded" style labels last. */
function countBy<T>(items: T[], key: (t: T) => string): [string, number][] {
    const m = new Map<string, number>();
    items.forEach(i => { const k = key(i); m.set(k, (m.get(k) || 0) + 1); });
    const last = (k: string) => /^not (recorded|available)/i.test(k) || k === "Unknown" ? 1 : 0;
    return [...m.entries()].sort((a, b) => last(a[0]) - last(b[0]) || b[1] - a[1] || a[0].localeCompare(b[0]));
}

function countRows(entries: [string, number][]): Cell[][] {
    const total = sum(entries.map(e => e[1]));
    return entries.map(([k, n]) => [k, n, percent(n, total)]);
}

function courseLabel(c: SCourse | undefined): string {
    if (!c) return "Deleted course";
    return [c.code, c.name].filter(Boolean).join(" ") || "Unnamed course";
}

const statusText = (c: SCourse) => cap(normStatus(c.status)) || "Not set";

/** "BL9 0AB" -> "BL9"; "M1" stays "M1". */
export function outwardCode(pc: unknown): string {
    const s = String(pc ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!s) return "Not recorded";
    return s.length >= 5 ? s.slice(0, -3) : s;
}

/** Age from the date of birth (worked out when loading), else the age typed on the record. */
function ageOf(dobAge: unknown, age: unknown): number | null {
    if (typeof dobAge === "number" && dobAge >= 0 && dobAge < 120) return dobAge;
    const n = Number(age);
    return Number.isFinite(n) && n > 0 && n < 120 ? Math.floor(n) : null;
}

export const AGE_GROUPS = ["Under 12", "12 to 17", "18 to 24", "25 to 49", "50 to 64", "65 and over", "Not recorded"];
function ageGroup(a: number | null): string {
    if (a === null) return "Not recorded";
    if (a < 12) return "Under 12";
    if (a < 18) return "12 to 17";
    if (a < 25) return "18 to 24";
    if (a < 50) return "25 to 49";
    if (a < 65) return "50 to 64";
    return "65 and over";
}

const kpi = (id: string, label: string, value: Cell, hint?: string, now?: boolean): StatKpi => ({ id, label, value, hint, now });

function table(section: SectionId, key: string, title: string, columns: string[], rows: Cell[][], extra: Partial<StatTable> = {}): StatTable {
    return { id: `${section}.${key}`, title, columns, rows, ...extra };
}

// ---------------------------------------------------------------- the calculation

export function computeStatistics(raw: StatsRaw, opts: StatsOptions): StatSection[] {
    const now = opts.now || new Date();
    const today = todayStr(now);
    const range = opts.range;
    const all: StatsData = raw.data;

    const scopeCourses = all.courses.filter(c =>
        (opts.typeFilter === "all" || normType(c.type) === opts.typeFilter)
        && (opts.statusFilter === "all" || (opts.statusFilter === "running" ? isRunning(c) : isFinished(c))));
    const scopeIds = new Set(scopeCourses.map(c => c.id));
    const filtered = opts.typeFilter !== "all" || opts.statusFilter !== "all";
    // Logged hours belong to no course, so they count only when no course filter is on.
    const data: StatsData = filtered ? restrictToCourses(all, scopeIds, { keepActivities: false }) : all;
    const cd = cleanData(data);
    const cAll = cleanData(all);

    const users = all.users || [];
    const students = all.students || [];
    const userById = new Map(users.map(u => [u.id, u]));
    const studentById = new Map(students.map(s => [s.id, s]));
    const courseById = new Map(all.courses.map(c => [c.id, c]));
    const personName = (id: string) => { const u = userById.get(id); return u ? (String(u.name || "").trim() || "Unnamed person") : "Deleted account"; };
    const studentName = (id: string) => String(studentById.get(id)?.name || "").trim() || "Unnamed student";
    const roleText = (r: unknown) => cap(String(r || "").replace(/_/g, " ")) || "No role";
    const priv = raw.studentPrivate;
    const privOf = (id: string) => (priv ? priv[id] : undefined);

    // Shared figures for the period and the filters.
    const perCourse = courseAttendance(data, range);
    const figures = courseFigures(data, range);
    const learnerBy = learnerHoursByCourse(data, range);
    const learnersBy = learnersByCourse(data, range);
    const teachersNow = teachersByCourse(data);
    const hours = volunteerHoursByPerson(data, range);
    const activePeriod = activeVolunteerIds(data, range);
    const active90 = activeInLastDays(data, ACTIVE_DAYS, now);
    const registered = registeredVolunteerIds(all);
    const historic = historicTeacherIds(data);
    const one = oneToOneByCourse(data, range);
    const attIn = cd.attendance.filter(a => inRange(a.date, range));
    const nonOneCourse = (id: string) => !isOneToOne(courseById.get(id));

    // Classes held: distinct (course, date) of courses that take registers.
    const classKeys = new Set<string>();
    const nobodyCame = new Set<string>();
    attIn.forEach(a => {
        if (!nonOneCourse(a.courseId!)) return;
        classKeys.add(`${a.courseId}|${a.date}`);
        if (a.held === true && !a.studentId && !a.userId) nobodyCame.add(`${a.courseId}|${a.date}`);
    });
    // A marker on a day someone was also ticked is not "nobody came".
    attIn.forEach(a => { if (a.studentId || a.userId) nobodyCame.delete(`${a.courseId}|${a.date}`); });
    const classList = [...classKeys].map(k => { const [courseId, date] = k.split("|"); return { courseId, date }; });

    const oneIn = cd.oneToOne.filter(o => inRange(dayOf(o.date), range));

    // Register grids (period only) for student level figures.
    const gridCourses = scopeCourses.filter(c => !isOneToOne(c));
    const grids = new Map<string, RegisterGrid>();
    gridCourses.forEach(c => grids.set(c.id, buildRegisterGrid(c, cd.roster, students, attIn, users, cd.assignments)));

    const headlineIds = defaultHeadlineCourseIds(scopeCourses);
    const rollingIds = allRollingCourseIds(scopeCourses);
    const headRunning = attendanceHeadline(perCourse, headlineIds);
    const headRolling = attendanceHeadline(perCourse, rollingIds);
    const learnerHoursTotal = sum(Object.values(learnerBy));
    const volunteerHoursTotal = sum([...activePeriod].map(id => hours[id]?.total || 0));
    const oneSessions = sum(Object.values(one).map(x => x.sessions));
    const oneHours = sum(Object.values(one).map(x => x.hours));

    // Students: who counts as "ever" under the filters.
    const studentEverIds = new Set<string>();
    if (!filtered) students.forEach(s => studentEverIds.add(s.id));
    else {
        cd.roster.forEach(r => studentEverIds.add(r.studentId!));
        cd.attendance.forEach(a => { if (a.studentId && studentById.has(a.studentId)) studentEverIds.add(a.studentId); });
    }
    const nowIds = new Set(enrolledNow(data));
    const learnerIds = new Set<string>();
    attIn.forEach(a => { if (a.studentId && studentById.has(a.studentId)) learnerIds.add(a.studentId); });

    const volAppsIn = raw.volunteerApps ? raw.volunteerApps.filter(a => inRange(dayOf(a.submittedAt), range)) : null;
    const subsIn = raw.submissions ? raw.submissions.filter(s => inRange(dayOf(s.submittedAt), range)) : null;

    const sections: StatSection[] = [];

    // ================================================================ 1. Headline
    {
        const running = scopeCourses.filter(isRunning).length;
        const planned = scopeCourses.filter(c => normStatus(c.status) === "planned").length;
        const finished = scopeCourses.filter(isFinished).length;
        sections.push({
            id: "headline", number: 1, title: "Headline figures",
            definition: "The main figures for the period and filters. Figures marked \"now\" are today's.",
            kpis: [
                kpi("headline.studentsNow", "Students now", nowIds.size, "On the roster of a running course", true),
                kpi("headline.studentsEver", "Students ever", studentEverIds.size, filtered ? "Ever on the chosen courses" : "Every student record, archived included"),
                kpi("headline.learners", "Learners in the period", learnerIds.size, "Students ticked present at least once"),
                kpi("headline.active90", "Active volunteers", active90.size, `Taught or had hours approved in the last ${ACTIVE_DAYS} days, any role`, true),
                kpi("headline.activePeriod", "Volunteers active in the period", activePeriod.size, "Taught or had hours approved in the period"),
                kpi("headline.registered", "Registered volunteers", registered.size, "Volunteer role, not archived", true),
                kpi("headline.historic", "Historic volunteers", historic.size, "Everyone who has ever taught a class or a 1-2-1"),
                kpi("headline.coursesRunning", "Courses running", running, undefined, true),
                kpi("headline.coursesPlanned", "Courses planned", planned, undefined, true),
                kpi("headline.coursesFinished", "Courses finished", finished, "Completed or cancelled", true),
                kpi("headline.classes", "Classes held", classKeys.size, "Days a register was taken, 1-2-1 left out"),
                kpi("headline.attendance", "Attendance", headRunning.rate === null ? null : `${headRunning.rate}%`, "Average of the running Rolling course rates"),
                kpi("headline.attendanceRolling", "Attendance, all Rolling courses", headRolling.rate === null ? null : `${headRolling.rate}%`, "Running and finished, as used for funders"),
                kpi("headline.learnerHours", "Learner hours", Math.round(learnerHoursTotal), "Each learner's time in class"),
                kpi("headline.volunteerHours", "Volunteer hours", Math.round(volunteerHoursTotal), filtered ? "Teaching and 1-2-1 on the chosen courses" : "Teaching, 1-2-1 and approved logged hours"),
                kpi("headline.oneSessions", "1-2-1 sessions", oneSessions),
                kpi("headline.oneHours", "1-2-1 hours", round1(oneHours)),
                kpi("headline.volApps", "Volunteer applications", volAppsIn ? volAppsIn.length : null, volAppsIn ? "Received in the period" : "Needs Volunteer Applications permission"),
                kpi("headline.studentApps", "Student applications", subsIn ? subsIn.length : null, subsIn ? "Received in the period" : "Needs Student Applications permission"),
            ],
            tables: [],
        });
    }

    // ================================================================ 2. Attendance
    {
        const rows: Cell[][] = gridCourses.map(c => {
            const a = perCourse[c.id];
            return [c.code || "", c.name || "", normType(c.type), statusText(c), a?.sessions || 0, figures[c.id]?.students || 0, a?.present || 0, a?.expected || 0, isRolling(c) && a && a.rate !== null ? a.rate : null];
        }).sort((x, y) => String(x[0]).localeCompare(String(y[0])));

        const months = monthKeys(range, classList.map(c => c.date), today);
        const monthRows: Cell[][] = months.map(m => {
            const mr: DateRange = { from: `${m}-01`, to: `${m}-31` };
            if (range.from && range.from > mr.from!) mr.from = range.from;
            if (range.to && range.to < mr.to!) mr.to = range.to;
            const held = classList.filter(c => monthOf(c.date) === m).length;
            const seen = new Set<string>();
            attIn.forEach(a => { if (a.studentId && monthOf(a.date) === m && nonOneCourse(a.courseId!)) seen.add(`${a.studentId}|${a.courseId}|${a.date}`); });
            const h = attendanceHeadline(courseAttendance(data, mr), rollingIds);
            return [monthLabel(m), held, seen.size, h.rate];
        });

        const wdClasses = WEEKDAYS.map(() => 0);
        const wdPresent = WEEKDAYS.map(() => 0);
        classList.forEach(c => { wdClasses[weekdayOf(c.date)]++; });
        const seenWd = new Set<string>();
        attIn.forEach(a => {
            if (!a.studentId || !nonOneCourse(a.courseId!)) return;
            const k = `${a.studentId}|${a.courseId}|${a.date}`;
            if (seenWd.has(k)) return;
            seenWd.add(k);
            wdPresent[weekdayOf(a.date!)]++;
        });
        const wdRows: Cell[][] = WEEKDAYS.map((d, i) => [d, wdClasses[i], wdPresent[i], wdClasses[i] > 0 ? round1(wdPresent[i] / wdClasses[i]) : null]).filter(r => (r[1] as number) > 0);

        const rated = scopeCourses.filter(c => isRolling(c) && perCourse[c.id]?.rate !== null && perCourse[c.id]?.rate !== undefined)
            .map(c => ({ c, rate: perCourse[c.id].rate as number, sessions: perCourse[c.id].sessions }))
            .sort((a, b) => b.rate - a.rate);
        const best = rated.slice(0, 5).map(r => [courseLabel(r.c), r.sessions, r.rate] as Cell[]);
        const lowest = [...rated].reverse().slice(0, 5).map(r => [courseLabel(r.c), r.sessions, r.rate] as Cell[]);

        const low: Cell[][] = [];
        const never: Cell[][] = [];
        gridCourses.forEach(c => {
            const g = grids.get(c.id)!;
            if (g.dates.length === 0) return;
            g.students.forEach(s => {
                if (!s.onRoster || s.archived) return;
                if (isRolling(c) && s.expected >= 3 && s.rate !== null && s.rate < 50) low.push([s.name, courseLabel(c), s.attended, s.expected, s.rate]);
                if (s.attended === 0) never.push([s.name, courseLabel(c), s.expected]);
            });
        });
        low.sort((a, b) => (a[4] as number) - (b[4] as number));
        const duplicates = sum(Object.values(perCourse).map(a => a.duplicatesIgnored || 0));

        sections.push({
            id: "attendance", number: 2, title: "Attendance",
            definition: "Fair course rate: each class is compared with the students who belonged to the course that day; each student counts once per day. Rolling courses only.",
            kpis: [
                kpi("attendance.running", "Attendance, running Rolling courses", headRunning.rate === null ? null : `${headRunning.rate}%`, `${headRunning.present} present of ${headRunning.expected} expected, ${headRunning.courses} courses`),
                kpi("attendance.rolling", "Attendance, all Rolling courses", headRolling.rate === null ? null : `${headRolling.rate}%`, `${headRolling.present} present of ${headRolling.expected} expected, ${headRolling.courses} courses`),
                kpi("attendance.present", "Student attendances", sum(rows.map(r => r[6] as number)), "Ticks, once per student per class"),
                kpi("attendance.low", "Students under 50%", low.length, "On a Rolling course now, at least 3 classes"),
                kpi("attendance.never", "Students who never came", never.length, "On a roster now, no tick in the period"),
                kpi("attendance.duplicates", "Double ticks ignored", duplicates, "Registers saved twice on the same day"),
            ],
            tables: [
                table("attendance", "perCourse", "Attendance by course", ["Code", "Course", "Type", "Status", "Classes held", "Students now", "Present", "Expected", "Attendance %"], rows),
                table("attendance", "months", "Attendance by month", ["Month", "Classes held", "Student attendances", "Attendance %"], monthRows, { chart: { label: 0, value: 3, months: true, percent: true }, note: "Attendance % is the average of the Rolling course rates for that month." }),
                table("attendance", "weekday", "Attendance by day of the week", ["Day", "Classes held", "Student attendances", "Average per class"], wdRows, { chart: { label: 0, value: 3 } }),
                table("attendance", "best", "Best attendance", ["Course", "Classes held", "Attendance %"], best, { chart: { label: 0, value: 2, percent: true } }),
                table("attendance", "lowest", "Lowest attendance", ["Course", "Classes held", "Attendance %"], lowest, { chart: { label: 0, value: 2, percent: true } }),
                table("attendance", "low", "Students with attendance under 50%", ["Student", "Course", "Attended", "Of", "Attendance %"], low, { names: true, screenOnly: true, note: "Screen only: never printed or exported." }),
                table("attendance", "never", "Students on a roster who never came in the period", ["Student", "Course", "Classes held since they joined"], never, { names: true, screenOnly: true, note: "Screen only: never printed or exported." }),
            ],
        });
    }

    // ================================================================ 3. Classes and reports
    {
        const reports = raw.classRecords ? raw.classRecords.filter(r => scopeIds.has(r.courseId) && inRange(dayOf(r.date), range)) : null;
        const reportKeys = new Set((reports || []).map(r => `${r.courseId}|${dayOf(r.date)}`));
        const withoutReport = classList.filter(c => !reportKeys.has(`${c.courseId}|${c.date}`));
        const months = monthKeys(range, [...classList.map(c => c.date), ...(reports || []).map(r => dayOf(r.date))], today);
        const monthRows: Cell[][] = months.map(m => [
            monthLabel(m),
            classList.filter(c => monthOf(c.date) === m).length,
            [...nobodyCame].filter(k => monthOf(k.split("|")[1]) === m).length,
            reports ? reports.filter(r => monthOf(dayOf(r.date)) === m).length : null,
        ]);
        const byCourse: Cell[][] = gridCourses.map(c => {
            const held = classList.filter(x => x.courseId === c.id).length;
            const reps = reports ? reports.filter(r => r.courseId === c.id).length : null;
            const without = reports ? withoutReport.filter(x => x.courseId === c.id).length : null;
            const empty = [...nobodyCame].filter(k => k.startsWith(`${c.id}|`)).length;
            return [courseLabel(c), held, reps, without, empty];
        }).filter(r => (r[1] as number) > 0 || (r[2] as number) > 0).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
        const wd = WEEKDAYS.map(() => 0);
        classList.forEach(c => wd[weekdayOf(c.date)]++);
        const byAuthor: Cell[][] = reports ? countBy(reports, r => r.volunteerId || "").map(([id, n]) => {
            const courses = new Set(reports.filter(r => (r.volunteerId || "") === id).map(r => r.courseId)).size;
            return [id ? personName(id) : "No author recorded", n, courses];
        }) : [];
        const notes = ["Registers taken in the app and in the portal are saved the same way, so they cannot be told apart."];
        if (!reports) notes.push("Could not load class reports.");
        sections.push({
            id: "classes", number: 3, title: "Classes and class reports",
            definition: "A class held is a day with a register (any tick, or \"nobody came\"). A class report is a report saved for that course and date.",
            kpis: [
                kpi("classes.held", "Classes held", classList.length),
                kpi("classes.nobody", "\"Nobody came\" classes", nobodyCame.size, "Class held, no one ticked"),
                kpi("classes.reports", "Class reports submitted", reports ? reports.length : null),
                kpi("classes.without", "Classes without a report", reports ? withoutReport.length : null),
                kpi("classes.coverage", "Classes with a report", reports && classList.length > 0 ? `${percent(classList.length - withoutReport.length, classList.length)}%` : null),
            ],
            tables: [
                table("classes", "months", "Classes and reports by month", ["Month", "Classes held", "Nobody came", "Reports"], monthRows, { chart: { label: 0, value: 1, months: true } }),
                table("classes", "courses", "Classes and reports by course", ["Course", "Classes held", "Reports", "Classes without a report", "Nobody came"], byCourse),
                table("classes", "weekday", "Classes by day of the week", ["Day", "Classes held"], WEEKDAYS.map((d, i) => [d, wd[i]] as Cell[]).filter(r => (r[1] as number) > 0), { chart: { label: 0, value: 1 } }),
                table("classes", "authors", "Class reports by author", ["Person", "Reports", "Courses"], byAuthor, { names: true }),
            ],
            notes,
        });
    }

    // ================================================================ 4. Students
    {
        const ever = students.filter(s => studentEverIds.has(s.id));
        const nowList = ever.filter(s => nowIds.has(s.id));
        const learners = ever.filter(s => learnerIds.has(s.id));
        const archived = ever.filter(isArchived).length;
        const newIn = ever.filter(s => inRange(dayOf(s.createdAt), range));
        const field = (s: any, k: "ethnicity" | "nationality") => s[k] || privOf(s.id)?.[k];
        const privMissing = priv === null;

        /** One table per dimension: counts among students now, learners in the period and all students ever. */
        const dimension = (key: string, title: string, label: (s: any) => string, order?: string[]): StatTable => {
            const counts = (list: any[]) => { const m = new Map<string, number>(); list.forEach(s => { const k = label(s); m.set(k, (m.get(k) || 0) + 1); }); return m; };
            const [a, b, c] = [counts(nowList), counts(learners), counts(ever)];
            const keys = order ? order.filter(k => c.has(k)) : countBy(ever, label).map(e => e[0]);
            const rows: Cell[][] = keys.map(k => [k, a.get(k) || 0, b.get(k) || 0, c.get(k) || 0]);
            return table("students", key, title, ["Group", "Students now", "Learners in the period", "Students ever"], rows, { chart: { label: 0, value: 3 } });
        };
        const missingText = (k: "ethnicity" | "nationality") => (s: any) => { const v = String(field(s, k) || "").trim(); return v ? cap(v) : (privMissing ? "Not available" : "Not recorded"); };

        const newMonths = monthKeys(range, newIn.map(s => dayOf(s.createdAt)), today);
        const newRows: Cell[][] = newMonths.map(m => [monthLabel(m), newIn.filter(s => monthOf(dayOf(s.createdAt)) === m).length]);

        const coursesPer = new Map<string, Set<string>>();
        cd.roster.forEach(r => (coursesPer.get(r.studentId!) || coursesPer.set(r.studentId!, new Set()).get(r.studentId!)!).add(r.courseId!));
        const perBand = (n: number) => (n >= 4 ? "4 or more" : String(n));
        const enrolRows: Cell[][] = countRows(countBy(ever, s => perBand(coursesPer.get(s.id)?.size || 0)).sort((a, b) => a[0].localeCompare(b[0])));
        const multi = ever.filter(s => (coursesPer.get(s.id)?.size || 0) > 1).length;

        // Retention: of the students who started on a Rolling course (in the period), how many were
        // still on it N classes later. Only students whose course has held N classes since they started count.
        const retention: Cell[][] = [2, 4, 8, 12].map(n => {
            let could = 0, stayed = 0;
            gridCourses.filter(isRolling).forEach(c => {
                const g = grids.get(c.id)!;
                g.students.forEach(s => {
                    if (!s.span) return;
                    const since = g.dates.filter(d => d >= s.span!.from).length;
                    if (since < n) return;
                    could++;
                    if (s.expected >= n) stayed++;
                });
            });
            return [`${n} classes`, stayed, could, percent(stayed, could)];
        });

        const notes: string[] = [];
        if (privMissing) notes.push("Date of birth, ethnicity and nationality are private details your account cannot read: those figures show \"Not available\" or use the age on the record.");
        sections.push({
            id: "students", number: 4, title: "Students",
            definition: "Students now are on the roster of a running course; students ever are every student record (archived included); learners were ticked present in the period.",
            kpis: [
                kpi("students.now", "Students now", nowList.length, undefined, true),
                kpi("students.ever", "Students ever", ever.length),
                kpi("students.learners", "Learners in the period", learners.length),
                kpi("students.new", "New students in the period", newIn.length, "Student record created in the period"),
                kpi("students.archived", "Archived students", archived, undefined, true),
                kpi("students.multi", "On more than one course", multi, "Ever on the roster of two or more courses"),
                kpi("students.notNow", "Not on a running course", ever.filter(s => !isArchived(s) && !nowIds.has(s.id)).length, "Not archived", true),
            ],
            tables: [
                table("students", "new", "New students by month", ["Month", "New students"], newRows, { chart: { label: 0, value: 1, months: true } }),
                dimension("age", "Age group", s => ageGroup(ageOf(s.dobAge ?? privOf(s.id)?.dobAge, s.age)), AGE_GROUPS),
                dimension("gender", "Gender", s => cap(clean(s.gender))),
                dimension("nationality", "Nationality", missingText("nationality")),
                dimension("ethnicity", "Ethnicity", missingText("ethnicity")),
                dimension("postcode", "Postcode district", s => outwardCode(s.postcode)),
                table("students", "enrolments", "Courses per student", ["Courses", "Students", "%"], enrolRows),
                table("students", "retention", "Retention on Rolling courses", ["Still on the course after", "Students", "Of students who could be", "%"], retention, { note: "Students whose course held at least that many classes after they started." }),
            ],
            notes,
        });
    }

    // ================================================================ 5. Volunteers and teachers
    {
        const pendingIn = !filtered && raw.pendingActivities ? raw.pendingActivities.filter(a => inRange(activityDay(a), range)) : [];
        const pendingBy = new Map<string, number>();
        pendingIn.forEach(a => { if (a.volunteerId) pendingBy.set(a.volunteerId, (pendingBy.get(a.volunteerId) || 0) + (Number(a.hours) || 0)); });
        const coursesTaught = new Map<string, Set<string>>();
        const addCourse = (uid: string, cid: string) => (coursesTaught.get(uid) || coursesTaught.set(uid, new Set()).get(uid)!).add(cid);
        attIn.forEach(a => { if (a.userId) addCourse(a.userId, a.courseId!); });
        oneIn.forEach(o => { if (o.volunteerId && o.courseId) addCourse(o.volunteerId, o.courseId); });
        const earnedIn = raw.earned ? raw.earned.filter(e => inRange(dayOf(e.earnedAt), range)) : null;
        const badgesBy = new Map<string, number>();
        (earnedIn || []).forEach(e => badgesBy.set(e.volunteerId, (badgesBy.get(e.volunteerId) || 0) + 1));

        const people = users.filter(u => {
            const h = hours[u.id];
            return (h && (h.classes > 0 || h.otherHours > 0)) || pendingBy.has(u.id) || (!filtered && registered.has(u.id));
        });
        const personRows: Cell[][] = people.map(u => {
            const h = hours[u.id];
            return [
                personName(u.id), roleText(u.role), isArchived(u) ? "Archived" : active90.has(u.id) ? "Active" : "Not active lately",
                h?.classSessions || 0, h?.oneToOneSessions || 0, round1(h?.classHours || 0), round1(h?.oneToOneHours || 0), round1(h?.otherHours || 0),
                round1(pendingBy.get(u.id) || 0), round1(h?.total || 0), coursesTaught.get(u.id)?.size || 0, h?.lastClass || "",
                earnedIn ? badgesBy.get(u.id) || 0 : null,
            ];
        }).sort((a, b) => (b[9] as number) - (a[9] as number) || String(a[0]).localeCompare(String(b[0])));

        // First class ever taught per person, and new volunteer accounts.
        const firstClass = new Map<string, string>();
        const seeFirst = (uid: string, d?: string) => { if (!d) return; const p = firstClass.get(uid); if (!p || d < p) firstClass.set(uid, d); };
        cd.attendance.forEach(a => { if (a.userId) seeFirst(a.userId, a.date); });
        cd.oneToOne.forEach(o => { if (o.volunteerId) seeFirst(o.volunteerId, dayOf(o.date)); });
        const newAccounts = users.filter(u => normRole(u.role) === "volunteer" && inRange(dayOf(u.createdAt), range));
        const firstIn = [...firstClass.entries()].filter(([, d]) => inRange(d, range));
        const nvMonths = monthKeys(range, [...newAccounts.map(u => dayOf(u.createdAt)), ...firstIn.map(f => f[1])], today);
        const nvRows: Cell[][] = nvMonths.map(m => [monthLabel(m), newAccounts.filter(u => monthOf(dayOf(u.createdAt)) === m).length, firstIn.filter(f => monthOf(f[1]) === m).length]);

        // Hours by month (same rules as volunteerHoursByPerson, per month).
        const hm = new Map<string, { c: number; o: number; l: number }>();
        const hget = (m: string) => hm.get(m) || hm.set(m, { c: 0, o: 0, l: 0 }).get(m)!;
        const seenT = new Set<string>();
        attIn.forEach(a => {
            if (!a.userId) return;
            const k = `${a.userId}|${a.courseId}|${a.date}`;
            if (seenT.has(k)) return;
            seenT.add(k);
            hget(monthOf(a.date)).c += courseLengthHours(courseById.get(a.courseId!));
        });
        oneIn.forEach(o => { if (o.volunteerId) hget(monthOf(dayOf(o.date))).o += (Number(o.durationMinutes) || 0) / 60; });
        cd.activities.forEach(a => { const d = activityDay(a); if (a.volunteerId && inRange(d, range)) hget(monthOf(d)).l += Number(a.hours) || 0; });
        const hMonths = monthKeys(range, [...hm.keys()].map(k => `${k}-01`), today);
        const hRows: Cell[][] = hMonths.map(m => { const x = hm.get(m) || { c: 0, o: 0, l: 0 }; return [monthLabel(m), round1(x.c), round1(x.o), round1(x.l), round1(x.c + x.o + x.l)]; });

        const top: Cell[][] = personRows.filter(r => (r[9] as number) > 0).slice(0, 10).map(r => [r[0], r[3], r[9]]);
        const roles = countBy(users, u => roleText(u.role)).map(([r]) => [r, users.filter(u => roleText(u.role) === r && !isArchived(u)).length, users.filter(u => roleText(u.role) === r && isArchived(u)).length] as Cell[]);

        const notes: string[] = [];
        if (filtered) notes.push("A course filter is on: approved and pending logged hours belong to no course, so they are left out.");
        if (!raw.pendingActivities) notes.push("Could not load pending hours.");
        sections.push({
            id: "volunteers", number: 5, title: "Volunteers and teachers",
            definition: `Classes taught are distinct classes with the person's tick plus their 1-2-1 sessions; hours are the class length, 1-2-1 minutes and approved logged hours (the badge rules). Active: taught or had hours approved in the last ${ACTIVE_DAYS} days.`,
            kpis: [
                kpi("volunteers.active90", "Active volunteers", active90.size, `Last ${ACTIVE_DAYS} days, any role`, true),
                kpi("volunteers.activePeriod", "Active in the period", activePeriod.size),
                kpi("volunteers.registered", "Registered volunteers", registered.size, "Volunteer role, not archived", true),
                kpi("volunteers.historic", "Historic volunteers", historic.size, "Ever taught a class or a 1-2-1, archived included"),
                kpi("volunteers.hours", "Volunteer hours", round1(volunteerHoursTotal)),
                kpi("volunteers.pending", "Hours waiting for approval", round1(sum([...pendingBy.values()]))),
                kpi("volunteers.new", "New volunteer accounts", newAccounts.length, "Created in the period"),
            ],
            tables: [
                table("volunteers", "people", "Per volunteer or teacher", ["Name", "Role", "Status now", "Classes taught", "1-2-1 sessions", "Class hours", "1-2-1 hours", "Logged hours approved", "Hours pending", "Total hours", "Courses taught", "Last class", "Badges earned"], personRows, { names: true }),
                table("volunteers", "top", "Top contributors", ["Name", "Classes taught", "Total hours"], top, { names: true, chart: { label: 0, value: 2 } }),
                table("volunteers", "hours", "Volunteer hours by month", ["Month", "Class hours", "1-2-1 hours", "Logged hours", "Total"], hRows, { chart: { label: 0, value: 4, months: true } }),
                table("volunteers", "new", "New volunteers by month", ["Month", "New volunteer accounts", "Taught their first class"], nvRows, { chart: { label: 0, value: 2, months: true } }),
                table("volunteers", "roles", "Accounts by role", ["Role", "Now", "Archived"], roles),
            ],
            notes,
        });
    }

    // ================================================================ 6. Courses
    {
        const reports = raw.classRecords ? raw.classRecords.filter(r => inRange(dayOf(r.date), range)) : null;
        const rows: Cell[][] = scopeCourses.map(c => {
            const f = figures[c.id];
            const a = perCourse[c.id];
            return [
                c.code || "", c.name || "", normType(c.type), statusText(c), clean(c.setting), clean(c.venue),
                (teachersNow[c.id] || []).length, f?.students || 0, f?.sessions || 0, round1(f?.hours || 0), round1(learnerBy[c.id] || 0),
                learnersBy[c.id] || 0, isRolling(c) && a && a.rate !== null ? a.rate : null,
                reports ? reports.filter(r => r.courseId === c.id).length : null, dayOf(c.startDate) || "", dayOf(c.endDate) || "",
            ];
        }).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
        const types = countBy(scopeCourses, c => normType(c.type)).map(([t]) => {
            const list = scopeCourses.filter(c => normType(c.type) === t);
            return [t, list.filter(isRunning).length, list.filter(c => normStatus(c.status) === "planned").length, list.filter(isFinished).length, list.filter(c => !isRunning(c) && !isFinished(c) && normStatus(c.status) !== "planned").length, list.length] as Cell[];
        });
        const venues = countBy(scopeCourses, c => `${clean(c.setting)}|${clean(c.venue)}`).map(([k, n]) => {
            const [setting, venue] = k.split("|");
            const running = scopeCourses.filter(c => clean(c.setting) === setting && clean(c.venue) === venue && isRunning(c)).length;
            return [setting, venue, n, running] as Cell[];
        });
        sections.push({
            id: "courses", number: 6, title: "Courses",
            definition: "Hours delivered are classes held times the course length (1-2-1: the logged minutes). Learner hours count each learner once per class. Teachers and students are today's.",
            kpis: [
                kpi("courses.total", "Courses", scopeCourses.length, "With the filters", true),
                kpi("courses.running", "Running", scopeCourses.filter(isRunning).length, undefined, true),
                kpi("courses.planned", "Planned", scopeCourses.filter(c => normStatus(c.status) === "planned").length, undefined, true),
                kpi("courses.finished", "Finished", scopeCourses.filter(isFinished).length, "Completed or cancelled", true),
                kpi("courses.hours", "Hours delivered", round1(sum(scopeCourses.map(c => figures[c.id]?.hours || 0)))),
                kpi("courses.learnerHours", "Learner hours", Math.round(learnerHoursTotal)),
            ],
            tables: [
                table("courses", "perCourse", "Per course", ["Code", "Course", "Type", "Status", "Setting", "Venue", "Teachers now", "Students now", "Classes held", "Hours delivered", "Learner hours", "Learners", "Attendance %", "Class reports", "Start", "End"], rows),
                table("courses", "types", "Courses by type and status", ["Type", "Running", "Planned", "Finished", "Other", "Total"], types),
                table("courses", "venues", "Courses by setting and venue", ["Setting", "Venue", "Courses", "Running now"], venues),
            ],
        });
    }

    // ================================================================ 7. 1-2-1
    {
        const byVol = countBy(oneIn, o => o.volunteerId || "").map(([id]) => {
            const list = oneIn.filter(o => (o.volunteerId || "") === id);
            return [id ? personName(id) : "Not recorded", list.length, round1(sum(list.map(o => (Number(o.durationMinutes) || 0) / 60))), new Set(list.map(o => o.studentId)).size] as Cell[];
        });
        const byCourse = countBy(oneIn, o => o.courseId || "").map(([id]) => {
            const list = oneIn.filter(o => (o.courseId || "") === id);
            return [courseLabel(courseById.get(id)), list.length, round1(sum(list.map(o => (Number(o.durationMinutes) || 0) / 60))), new Set(list.map(o => o.studentId)).size] as Cell[];
        });
        const months = monthKeys(range, oneIn.map(o => dayOf(o.date)), today);
        const mRows: Cell[][] = months.map(m => { const list = oneIn.filter(o => monthOf(dayOf(o.date)) === m); return [monthLabel(m), list.length, round1(sum(list.map(o => (Number(o.durationMinutes) || 0) / 60)))]; });
        sections.push({
            id: "oneToOne", number: 7, title: "1-2-1 sessions",
            definition: "Every logged 1-2-1 meeting between a volunteer and one person, with its length in minutes.",
            kpis: [
                kpi("oneToOne.sessions", "Sessions", oneIn.length),
                kpi("oneToOne.hours", "Hours", round1(sum(oneIn.map(o => (Number(o.durationMinutes) || 0) / 60)))),
                kpi("oneToOne.people", "People helped", new Set(oneIn.map(o => o.studentId).filter(Boolean)).size),
                kpi("oneToOne.volunteers", "Volunteers", new Set(oneIn.map(o => o.volunteerId).filter(Boolean)).size),
                kpi("oneToOne.courses", "1-2-1 courses running", scopeCourses.filter(c => isOneToOne(c) && isRunning(c)).length, undefined, true),
            ],
            tables: [
                table("oneToOne", "months", "1-2-1 by month", ["Month", "Sessions", "Hours"], mRows, { chart: { label: 0, value: 1, months: true } }),
                table("oneToOne", "courses", "1-2-1 by course", ["Course", "Sessions", "Hours", "People helped"], byCourse),
                table("oneToOne", "volunteers", "1-2-1 by volunteer", ["Volunteer", "Sessions", "Hours", "People helped"], byVol, { names: true }),
            ],
        });
    }

    // ================================================================ 8. Applications
    {
        const tables: StatTable[] = [];
        const kpis: StatKpi[] = [];
        const notes: string[] = [];
        if (volAppsIn) {
            const statusName: Record<string, string> = { new: "New", interview: "Interview booked", accepted: "Accepted", declined: "Declined", rejected: "Declined" };
            const reached = volAppsIn.filter(a => a.hadInterview || a.status === "interview" || a.status === "accepted").length;
            const accepted = volAppsIn.filter(a => a.status === "accepted").length;
            kpis.push(
                kpi("applications.volReceived", "Volunteer applications received", volAppsIn.length),
                kpi("applications.volInterview", "Reached interview", reached),
                kpi("applications.volAccepted", "Accepted", accepted),
                kpi("applications.volConversion", "Accepted of received", volAppsIn.length ? `${percent(accepted, volAppsIn.length)}%` : null),
                kpi("applications.volWaiting", "Still new", volAppsIn.filter(a => a.status === "new").length, "Nobody has looked at them yet"),
            );
            const months = monthKeys(range, volAppsIn.map(a => dayOf(a.submittedAt)), today);
            tables.push(
                table("applications", "volFunnel", "Volunteer applications: from received to accepted", ["Stage", "Applications", "% of received"], [
                    ["Received", volAppsIn.length, volAppsIn.length ? 100 : null], ["Reached interview", reached, percent(reached, volAppsIn.length)], ["Accepted", accepted, percent(accepted, volAppsIn.length)],
                ], { chart: { label: 0, value: 1 } }),
                table("applications", "volStatus", "Volunteer applications by status", ["Status", "Applications", "%"], countRows(countBy(volAppsIn, a => statusName[a.status] || cap(a.status)))),
                table("applications", "volMonths", "Volunteer applications by month", ["Month", "Received", "Accepted"], months.map(m => [monthLabel(m), volAppsIn.filter(a => monthOf(dayOf(a.submittedAt)) === m).length, volAppsIn.filter(a => monthOf(dayOf(a.submittedAt)) === m && a.status === "accepted").length]), { chart: { label: 0, value: 1, months: true } }),
                table("applications", "volRole", "Volunteer applications by role applied for", ["Role", "Applications", "%"], countRows(countBy(volAppsIn, a => clean(a.role)))),
                table("applications", "volHeard", "Where volunteer applicants heard about us", ["Heard from", "Applications", "%"], countRows(countBy(volAppsIn, a => clean(a.heardFrom))), { chart: { label: 0, value: 1 } }),
            );
        } else notes.push("Volunteer applications need the Volunteer Applications permission.");
        if (subsIn && raw.processes) {
            // 6 Oct 2026: New, Waiting list, Accepted, Declined (old "Rejected" counts as Declined).
            const st = (s?: string) => appStatusOf(s);
            const formName = (f?: string) => (f ? cap(f) : "Other form");
            kpis.push(
                kpi("applications.stuReceived", "Student applications received", subsIn.length),
                kpi("applications.stuAccepted", "Accepted", subsIn.filter(s => st(s.status) === "Accepted").length),
                kpi("applications.stuRejected", "Declined", subsIn.filter(s => st(s.status) === "Declined").length),
                kpi("applications.stuWaiting", "New (no decision yet)", subsIn.filter(s => st(s.status) === "New").length),
                kpi("applications.stuWaitingList", "On the waiting list", subsIn.filter(s => st(s.status) === "Waiting list").length),
                kpi("applications.processesOpen", "Application processes open", raw.processes.filter(p => p.status === "Open" && !p.archived).length, undefined, true),
            );
            const perProc: Cell[][] = raw.processes.map(p => {
                const list = subsIn.filter(s => s.processId === p.id);
                return [p.title, formName(p.formType), p.archived ? "Archived" : (p.status || ""), raw.submissionFailures.includes(p.title) ? null : list.length, list.filter(s => st(s.status) === "Accepted").length, list.filter(s => st(s.status) === "Declined").length, list.filter(s => st(s.status) === "Waiting list").length, list.filter(s => st(s.status) === "New").length];
            }).sort((a, b) => ((b[3] as number) || 0) - ((a[3] as number) || 0));
            const months = monthKeys(range, subsIn.map(s => dayOf(s.submittedAt)), today);
            tables.push(
                table("applications", "stuProcesses", "Student applications by process", ["Process", "Form", "Open or closed", "Received", "Accepted", "Declined", "Waiting list", "New"], perProc),
                table("applications", "stuForm", "Student applications by form", ["Form", "Applications", "%"], countRows(countBy(subsIn, s => formName(s.formType)))),
                table("applications", "stuStatus", "Student applications by status", ["Status", "Applications", "%"], countRows(countBy(subsIn, s => st(s.status)))),
                table("applications", "stuMonths", "Student applications by month", ["Month", "Received"], months.map(m => [monthLabel(m), subsIn.filter(s => monthOf(dayOf(s.submittedAt)) === m).length]), { chart: { label: 0, value: 1, months: true } }),
            );
            if (raw.submissionFailures.length) notes.push(`Could not read the applications of: ${raw.submissionFailures.join(", ")}.`);
        } else notes.push("Student applications need the Student Applications permission.");
        sections.push({
            id: "applications", number: 8, title: "Applications",
            definition: "Applications received in the period (the date they were sent). Reached interview: an interview was booked.",
            kpis, tables, notes,
            unavailable: !volAppsIn && !subsIn ? "Needs the Volunteer Applications or Student Applications permission." : undefined,
        });
    }

    // ================================================================ 9. Annual leave
    {
        if (!raw.leave) {
            sections.push({ id: "leave", number: 9, title: "Annual leave", definition: "Leave requests and balances.", kpis: [], tables: [], unavailable: "Needs the Approve Leave permission." });
        } else {
            const reqIn = raw.leave.filter(l => inRange(dayOf(l.startDate) || dayOf(l.createdAt), range));
            const approved = (t: string) => reqIn.filter(l => l.type === t && l.status === "approved");
            const daysOf = (list: typeof reqIn) => round1(sum(list.map(l => l.totalDays)));
            const people = users.filter(u => !isArchived(u) && (hasLeaveRole(String(u.role || "")) || u.leaveAllowance));
            const personRows: Cell[][] = people.map(u => {
                const la: any = u.leaveAllowance || {};
                const mine = reqIn.filter(l => l.userId === u.id);
                const pendingNow = raw.leave!.filter(l => l.userId === u.id && l.status === "pending" && l.type === "annual");
                return [
                    personName(u.id), roleText(u.role),
                    typeof la.entitlement === "number" ? la.entitlement : null, typeof la.carriedOver === "number" ? la.carriedOver : 0,
                    typeof la.total === "number" ? la.total : null,
                    daysOf(mine.filter(l => l.type === "annual" && l.status === "approved")),
                    typeof la.remaining === "number" ? la.remaining : null,
                    daysOf(pendingNow),
                    daysOf(mine.filter(l => l.type === "toil" && l.status === "approved")),
                ];
            }).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
            const TYPES = ["annual", "sick", "toil", "unpaid"];
            const TYPE_NAME: Record<string, string> = { annual: "Annual leave", sick: "Sick leave", toil: "TOIL", unpaid: "Unpaid leave" };
            const byType: Cell[][] = TYPES.map(t => {
                const list = reqIn.filter(l => l.type === t);
                return [TYPE_NAME[t], list.filter(l => l.status === "pending").length, list.filter(l => l.status === "approved").length, list.filter(l => l.status === "rejected").length, list.filter(l => l.status === "cancelled").length, list.length, daysOf(list.filter(l => l.status === "approved"))];
            });
            const months = monthKeys(range, reqIn.map(l => dayOf(l.startDate)), today);
            const mRows: Cell[][] = months.map(m => {
                const list = reqIn.filter(l => monthOf(dayOf(l.startDate)) === m);
                return [monthLabel(m), list.length, daysOf(list.filter(l => l.type === "annual" && l.status === "approved")), daysOf(list.filter(l => l.type === "sick" && l.status !== "rejected" && l.status !== "cancelled")), daysOf(list.filter(l => l.type === "toil" && l.status === "approved"))];
            });
            sections.push({
                id: "leave", number: 9, title: "Annual leave",
                definition: `Requests by their first day in the period. Balances (entitlement, carried over, days left) are now, for the leave year from 1 May ${leaveYearStart(now)}. Sick leave is shown as a total only, never per person.`,
                kpis: [
                    kpi("leave.requests", "Leave requests", reqIn.length),
                    kpi("leave.annual", "Annual leave days taken", daysOf(approved("annual")), "Approved"),
                    kpi("leave.pending", "Requests waiting now", raw.leave.filter(l => l.status === "pending").length, undefined, true),
                    kpi("leave.sick", "Sick days", daysOf(reqIn.filter(l => l.type === "sick" && l.status !== "rejected" && l.status !== "cancelled")), "Days only, no details"),
                    kpi("leave.toil", "TOIL days added", daysOf(approved("toil")), "Approved"),
                    kpi("leave.people", "People with annual leave", people.length, undefined, true),
                ],
                tables: [
                    table("leave", "people", "Leave per person", ["Name", "Role", "Entitlement", "Carried over", "Total this year", "Taken in the period", "Days left now", "Days waiting approval", "TOIL added"], personRows, { names: true }),
                    table("leave", "types", "Requests by type and status", ["Type", "Waiting", "Approved", "Rejected", "Cancelled", "Total", "Days approved"], byType),
                    table("leave", "months", "Leave by month", ["Month", "Requests", "Annual days taken", "Sick days", "TOIL days"], mRows, { chart: { label: 0, value: 2, months: true } }),
                ],
            });
        }
    }

    // ================================================================ 10. Policies
    {
        if (!raw.policies || !raw.reads) {
            sections.push({ id: "policies", number: 10, title: "Policies", definition: "Who has read each policy.", kpis: [], tables: [], unavailable: !raw.policies ? "Could not load the policies." : "Reading records can be read by admins only." });
        } else {
            const people: PolicyPerson[] = users.filter(u => !isArchived(u)).map(u => ({ uid: u.id, name: personName(u.id), group: audienceGroup(u.role) })).filter((p): p is PolicyPerson => !!p.group);
            const map: ReadMap = new Map();
            raw.reads.forEach(r => {
                const m = map.get(r.userId) || map.set(r.userId, new Map()).get(r.userId)!;
                m.set(r.policyId, { userId: r.userId, policyId: r.policyId, version: r.version, source: "portal" } as PolicyReadRecord);
            });
            const { byPolicy, totals } = policyStats(raw.policies, people, map);
            const rows: Cell[][] = raw.policies.map(p => {
                const s = byPolicy[p.id];
                return [p.title, AUDIENCE_LABEL[p.audience], p.version, s.staff.read, s.staff.total, pct(s.staff), s.volunteers.read, s.volunteers.total, pct(s.volunteers), pct(s.all)];
            });
            const unread = new Map<string, number>();
            Object.values(byPolicy).forEach(s => s.notRead.forEach(p => unread.set(p.uid, (unread.get(p.uid) || 0) + 1)));
            const unreadRows: Cell[][] = people.filter(p => unread.has(p.uid)).map(p => [p.name, p.group === "staff" ? "Staff" : "Volunteer", unread.get(p.uid) || 0]).sort((a, b) => (b[2] as number) - (a[2] as number));
            const txt = (c: { read: number; total: number }) => { const v = pct(c); return v === null ? null : `${v}%`; };
            sections.push({
                id: "policies", number: 10, title: "Policies",
                definition: "Now: each person who must read a policy counts once, only for its current version. Staff, admins and the super admin read staff and everyone policies; volunteers read volunteer and everyone policies.",
                kpis: [
                    kpi("policies.count", "Policies", raw.policies.length, undefined, true),
                    kpi("policies.all", "Read overall", txt(totals.all), `${totals.all.read} of ${totals.all.total} reads`, true),
                    kpi("policies.staff", "Read by staff", txt(totals.staff), undefined, true),
                    kpi("policies.volunteers", "Read by volunteers", txt(totals.volunteers), undefined, true),
                    kpi("policies.unread", "People with unread policies", unreadRows.length, undefined, true),
                ],
                tables: [
                    table("policies", "perPolicy", "Reading per policy", ["Policy", "Audience", "Version", "Staff read", "Staff total", "Staff %", "Volunteers read", "Volunteers total", "Volunteers %", "Overall %"], rows, { chart: { label: 0, value: 9, percent: true } }),
                    table("policies", "unread", "People with unread policies", ["Name", "Group", "Unread policies"], unreadRows, { names: true }),
                ],
                notes: raw.readsPartial ? ["Part of the reading records could not be read, so figures may be low."] : undefined,
            });
        }
    }

    // ================================================================ 11. Badges
    {
        if (!raw.badges || !raw.earned) {
            sections.push({ id: "badges", number: 11, title: "Badges", definition: "Badges earned.", kpis: [], tables: [], unavailable: "Could not load the badges." });
        } else {
            const defs = new Map(raw.badges.map(b => [b.id, b]));
            const earned = raw.earned.filter(e => defs.has(e.badgeId));
            const earnedIn = earned.filter(e => inRange(dayOf(e.earnedAt), range));
            const perBadge: Cell[][] = raw.badges.map(b => [b.name, clean(b.category, "No category"), b.archived ? "Archived" : "Available", earnedIn.filter(e => e.badgeId === b.id).length, earned.filter(e => e.badgeId === b.id).length])
                .sort((a, b) => (b[3] as number) - (a[3] as number) || (b[4] as number) - (a[4] as number));
            const months = monthKeys(range, earnedIn.map(e => dayOf(e.earnedAt)), today);
            const perPerson: Cell[][] = countBy(earned, e => e.volunteerId).map(([id, n]) => [personName(id), earnedIn.filter(e => e.volunteerId === id).length, n] as Cell[])
                .filter(r => (r[1] as number) > 0 || (!range.from && !range.to)).sort((a, b) => (b[1] as number) - (a[1] as number));
            sections.push({
                id: "badges", number: 11, title: "Badges",
                definition: "Badges earned in the period (automatic and awarded by hand). Archived badges are no longer available but people keep them.",
                kpis: [
                    kpi("badges.available", "Badges available", raw.badges.filter(b => !b.archived).length, undefined, true),
                    kpi("badges.earnedIn", "Badges earned", earnedIn.length),
                    kpi("badges.people", "People who earned a badge", new Set(earnedIn.map(e => e.volunteerId)).size),
                    kpi("badges.earnedEver", "Badges earned ever", earned.length),
                ],
                tables: [
                    table("badges", "perBadge", "Earned per badge", ["Badge", "Category", "State", "Earned in the period", "Earned ever"], perBadge, { chart: { label: 0, value: 3 } }),
                    table("badges", "months", "Badges earned by month", ["Month", "Badges earned"], months.map(m => [monthLabel(m), earnedIn.filter(e => monthOf(dayOf(e.earnedAt)) === m).length]), { chart: { label: 0, value: 1, months: true } }),
                    table("badges", "people", "Badges per person", ["Name", "In the period", "Ever"], perPerson, { names: true }),
                ],
            });
        }
    }

    // ================================================================ 12. Inventory
    {
        if (!raw.inventory) {
            sections.push({ id: "inventory", number: 12, title: "Inventory", definition: "Laptops and equipment.", kpis: [], tables: [], unavailable: "Needs the Inventory permission." });
        } else {
            const don = raw.donated || [];
            const was = raw.wasted || [];
            const donIn = don.filter(d => inRange(dayOf(d.donatedAt), range));
            const wasIn = was.filter(w => inRange(dayOf(w.wastedAt), range));
            const months = monthKeys(range, [...donIn.map(d => dayOf(d.donatedAt)), ...wasIn.map(w => dayOf(w.wastedAt))], today);
            const notes: string[] = [];
            if (!raw.donated) notes.push("Could not load donated items.");
            if (!raw.wasted) notes.push("Could not load wasted items.");
            sections.push({
                id: "inventory", number: 12, title: "Inventory",
                definition: "Items in the inventory now, and items donated or written off in the period. PINs are never shown.",
                kpis: [
                    kpi("inventory.now", "Items now", raw.inventory.length, undefined, true),
                    kpi("inventory.donatedIn", "Donated in the period", raw.donated ? donIn.length : null),
                    kpi("inventory.donatedEver", "Donated ever", raw.donated ? don.length : null),
                    kpi("inventory.wastedIn", "Written off in the period", raw.wasted ? wasIn.length : null),
                    kpi("inventory.wastedEver", "Written off ever", raw.wasted ? was.length : null),
                ],
                tables: [
                    table("inventory", "location", "Items by location (now)", ["Location", "Items", "%"], countRows(countBy(raw.inventory, i => clean(i.location, "Unknown"))), { chart: { label: 0, value: 1 } }),
                    table("inventory", "type", "Items by type (now)", ["Type", "Items", "%"], countRows(countBy(raw.inventory, i => clean(i.type, "Unknown"))), { chart: { label: 0, value: 1 } }),
                    table("inventory", "activity", "Items by activity (now)", ["Activity", "Items", "%"], countRows(countBy(raw.inventory, i => clean(i.activity))), { chart: { label: 0, value: 1 } }),
                    table("inventory", "months", "Donated and written off by month", ["Month", "Donated", "Written off"], months.map(m => [monthLabel(m), donIn.filter(d => monthOf(dayOf(d.donatedAt)) === m).length, wasIn.filter(w => monthOf(dayOf(w.wastedAt)) === m).length])),
                    table("inventory", "recipients", "Donated by recipient", ["Recipient", "Items", "%"], countRows(countBy(donIn, d => clean(d.donatedTo))), { names: true }),
                    table("inventory", "donatedType", "Donated by type", ["Type", "Items", "%"], countRows(countBy(donIn, d => clean(d.type, "Unknown")))),
                ],
                notes,
            });
        }
    }

    // ================================================================ 13. Recruitment and communications
    {
        const kpis: StatKpi[] = [];
        const tables: StatTable[] = [];
        const notes: string[] = [];
        if (raw.announcements) {
            const ann = raw.announcements;
            const live = ann.filter(a => isLive(a, today));
            const created = ann.filter(a => inRange(a.createdDay, range));
            kpis.push(
                kpi("comms.annLive", "Announcements live", live.length, undefined, true),
                kpi("comms.annExpired", "Announcements expired", ann.length - live.length, undefined, true),
                kpi("comms.annCreated", "Announcements published", created.length, "In the period"),
            );
            const sev: Record<string, string> = { info: "Information", important: "Important", urgent: "Urgent" };
            tables.push(table("comms", "announcements", "Announcements published in the period", ["Kind", "Everyone", "Staff", "Volunteers", "Total"],
                ["info", "important", "urgent"].map(s => { const l = created.filter(a => a.severity === s); return [sev[s], l.filter(a => a.audience === "everyone").length, l.filter(a => a.audience === "staff").length, l.filter(a => a.audience === "volunteers").length, l.length] as Cell[]; })));
        } else notes.push("Could not load announcements.");
        if (raw.socialPosts) {
            const posts = raw.socialPosts.filter(p => inRange(dayOf(p.publishedAt) || dayOf(p.createdAt), range));
            const published = posts.filter(p => p.status === "published");
            const statusName: Record<string, string> = { draft: "Draft", approved: "Approved", published: "Published", rejected: "Rejected", refused: "Refused (governance)", blockedSafeguarding: "Blocked (safeguarding)", failed: "Failed", removed: "Removed" };
            kpis.push(kpi("comms.posts", "Social media posts", posts.length, "Created or published in the period"), kpi("comms.published", "Posts published", published.length));
            tables.push(
                table("comms", "postStatus", "Social media posts by status", ["Status", "Posts", "%"], countRows(countBy(posts, p => statusName[p.status] || cap(p.status)))),
                table("comms", "postNetwork", "Social media posts by network", ["Network", "Posts", "Published"], countBy(posts, p => cap(p.network)).map(([n, c]) => [n, c, published.filter(p => cap(p.network) === n).length] as Cell[]), { chart: { label: 0, value: 1 } }),
            );
        } else notes.push("Social media posts need the Social Media permission.");
        if (raw.grants) {
            const g = raw.grants.filter((x: any) => x && x.archived !== true); // archived grants left out (1 Oct 2026)
            const granted = g.filter(x => x.status === "Granted");
            const failed = g.filter(x => x.status === "Failed");
            const sent = g.filter(x => x.status === "Application Sent" || x.status === "Granted");
            const money = (n: number) => `£${Math.round(n).toLocaleString("en-GB")}`;
            kpis.push(
                kpi("comms.grants", "Grants tracked", g.length, undefined, true),
                kpi("comms.grantsGranted", "Grants won", granted.length, undefined, true),
                kpi("comms.grantsRequested", "Amount applied for", money(sum(sent.map(x => x.amountRequested))), "Applications sent or granted", true),
                kpi("comms.grantsAwarded", "Amount granted", money(sum(granted.map(x => x.amountRequested || x.amount))), "Amount applied for on granted grants", true),
                kpi("comms.grantsSuccess", "Success rate", granted.length + failed.length > 0 ? `${percent(granted.length, granted.length + failed.length)}%` : null, "Won of won and failed", true),
            );
            tables.push(table("comms", "grants", "Grants by status (now)", ["Status", "Grants", "Most available", "Applied for"],
                countBy(g, x => x.status === "Granted" && x.grantProgress === "Finalised" ? "Granted (finalised)" : x.status).map(([s, n]) => {
                    const list = g.filter(x => (x.status === "Granted" && x.grantProgress === "Finalised" ? "Granted (finalised)" : x.status) === s);
                    return [s, n, money(sum(list.map(x => x.amount))), money(sum(list.map(x => x.amountRequested)))] as Cell[];
                }), { note: "All grants on the Grants page, the period does not apply." }));
        } else notes.push("Grants need the Grants and Funding permission.");
        sections.push({
            id: "comms", number: 13, title: "Recruitment and communications",
            definition: "Announcements, social media posts and grants. Announcements and posts count by the day they were published.",
            kpis, tables, notes,
            unavailable: !raw.announcements && !raw.socialPosts && !raw.grants ? "Could not load any of these." : undefined,
        });
    }

    // ================================================================ 14. Ghana
    sections.push({
        id: "ghana", number: 14, title: "Ghana",
        definition: "The Ghana classes are counted on their own page, from the Ghana app.",
        kpis: [], tables: [],
        link: { href: "/academy/ghana", label: "Open Ghana Operations" },
    });

    // ================================================================ 15. Data quality
    {
        const onRoster = new Set(cAll.roster.map(r => r.studentId!));
        const noRoster = students.filter(s => !isArchived(s) && !onRoster.has(s.id));
        const rosterAll = all.roster || [];
        const rosterNoCourse = rosterAll.filter(r => !r.courseId || !courseById.has(r.courseId)).length;
        const rosterNoStudent = rosterAll.filter(r => r.courseId && courseById.has(r.courseId) && (!r.studentId || !studentById.has(r.studentId))).length;
        const assignAll = all.assignments || [];
        const assignOrphans = assignAll.length - cAll.assignments.length;
        const attAll = all.attendance || [];
        const attNoCourse = attAll.filter(a => !a.courseId || !courseById.has(a.courseId)).length;
        const attNoStudent = attAll.filter(a => a.studentId && !studentById.has(a.studentId)).length;
        const noTimes = all.courses.filter(c => courseLengthHours(c) === 0 && !isOneToOne(c));
        const staffish = users.filter(u => !isArchived(u) && ["staff", "admin"].includes(normRole(u.role)));
        const noManager = staffish.filter(u => !u.managerId);
        const noRole = users.filter(u => !isArchived(u) && (!normRole(u.role) || normRole(u.role) === "standard_user"));
        const noCreated = students.filter(s => !dayOf(s.createdAt)).length;
        const duplicates = sum(Object.values(courseAttendance(all)).map(a => a.duplicatesIgnored || 0));
        const checks: Cell[][] = [
            ["Students (not archived) on no course roster", noRoster.length],
            ["Roster rows of deleted courses", rosterNoCourse],
            ["Roster rows of deleted students", rosterNoStudent],
            ["Teacher assignments of deleted courses or people", assignOrphans],
            ["Register ticks of deleted courses", attNoCourse],
            ["Register ticks of deleted students", attNoStudent],
            ["Double ticks (register saved twice)", duplicates],
            ["Courses with no class times (0 hours)", noTimes.length],
            ["Staff and admins with no line manager", noManager.length],
            ["Accounts with no role", noRole.length],
            ["Students with no created date", noCreated],
        ];
        sections.push({
            id: "quality", number: 15, title: "Data quality",
            definition: "Now, for all courses (the filters do not apply): records the figures above leave out or cannot place. Fixing them makes the figures more accurate.",
            kpis: [
                kpi("quality.noRoster", "Students on no roster", noRoster.length, undefined, true),
                kpi("quality.noTimes", "Courses with no times", noTimes.length, undefined, true),
                kpi("quality.orphans", "Rows of deleted records", rosterNoCourse + rosterNoStudent + assignOrphans + attNoCourse, undefined, true),
                kpi("quality.noManager", "No line manager", noManager.length, "Staff and admins", true),
                kpi("quality.noRole", "Accounts with no role", noRole.length, undefined, true),
            ],
            tables: [
                table("quality", "checks", "Checks", ["Check", "Count"], checks),
                table("quality", "noTimes", "Courses with no class times", ["Code", "Course", "Type", "Status"], noTimes.map(c => [c.code || "", c.name || "", normType(c.type), statusText(c)])),
                table("quality", "noManager", "Staff and admins with no line manager", ["Name", "Role"], noManager.map(u => [personName(u.id), roleText(u.role)]), { names: true }),
                table("quality", "noRole", "Accounts with no role", ["Name"], noRole.map(u => [personName(u.id)]), { names: true }),
                table("quality", "noRosterList", "Students on no course roster", ["Student", "Created"], noRoster.map(s => [studentName(s.id), dayOf(s.createdAt) || ""]), { names: true, screenOnly: true, note: "Screen only: never printed or exported." }),
            ],
        });
    }

    return sections;
}
