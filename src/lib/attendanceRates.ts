// Attendance rates (25 Sep 2026). Franco chose method A: every course has its own rate
// and the headline is the average of the course rates. This file makes each course's
// rate fair, fixing the two faults the old sums had:
//
// 1. A register saved twice on the same day counted every student twice
//    (C0004 showed 113%). Now each student counts once per course per day.
// 2. Every past class was compared with TODAY's student list, so a student who
//    joined late was marked absent for classes before they joined, and a student who
//    left made old classes look over 100%. Now each class is compared with the
//    students who belonged to the course at that time, worked out from the registers
//    themselves (the same "attendance span" rule the Ghana screen uses):
//      - a student belongs from their first register (or the day they were enrolled,
//        when the enrolment date is known) ...
//      - ... to their last register, or to the latest register if they are still on
//        the course today (so missed classes still count against them).
// A student on the course who has never come counts from their enrolment date; most
// older enrolments have no date, so the date their student record was created is used
// instead (never earlier than the course's first register).

export interface AttendanceRecord { courseId?: string; date?: string; studentId?: string; userId?: string }
export interface RosterRecord { courseId?: string; studentId?: string; enrolledAt?: string }
export interface CourseAttendance {
    sessions: number;          // days a register was taken
    present: number;           // student attendances, one per student per day
    expected: number;          // student places the course had across those days
    rate: number | null;       // present / expected, or null when there is nothing to measure
    duplicatesIgnored: number; // extra ticks from registers saved twice
}

/** Turns a Firestore Timestamp, Date or string into YYYY-MM-DD (or undefined). */
export function toDay(v: any): string | undefined {
    if (!v) return undefined;
    if (typeof v === "string") return v.slice(0, 10);
    if (typeof v.toDate === "function") return v.toDate().toISOString().slice(0, 10);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v.seconds === "number") return new Date(v.seconds * 1000).toISOString().slice(0, 10);
    return undefined;
}

/**
 * @param joinedFallback optional studentId -> YYYY-MM-DD, used for a roster student with no
 *        enrolment date who has never attended (normally the student record's createdAt).
 */
export function attendanceByCourse(records: AttendanceRecord[], roster: RosterRecord[], joinedFallback: Record<string, string | undefined> = {}): Record<string, CourseAttendance> {
    const dates: Record<string, Set<string>> = {};
    const presentByDate: Record<string, Record<string, Set<string>>> = {};
    const rawTicks: Record<string, number> = {};
    records.forEach(r => {
        if (!r.courseId || !r.date) return;
        (dates[r.courseId] ||= new Set()).add(r.date);
        if (r.studentId) {
            rawTicks[r.courseId] = (rawTicks[r.courseId] || 0) + 1;
            ((presentByDate[r.courseId] ||= {})[r.date] ||= new Set()).add(r.studentId);
        }
    });
    const onRoster: Record<string, Map<string, string | undefined>> = {};
    roster.forEach(r => {
        if (!r.courseId || !r.studentId) return;
        const m = (onRoster[r.courseId] ||= new Map());
        const enrolled = toDay(r.enrolledAt);
        const prev = m.get(r.studentId);
        m.set(r.studentId, prev && enrolled ? (prev < enrolled ? prev : enrolled) : (prev || enrolled));
    });

    const out: Record<string, CourseAttendance> = {};
    const courseIds = new Set([...Object.keys(dates), ...Object.keys(onRoster)]);
    courseIds.forEach(cid => {
        const days = [...(dates[cid] || [])].sort();
        const byDate = presentByDate[cid] || {};
        const latest = days[days.length - 1];
        const spans = new Map<string, { first: string; last: string }>();
        days.forEach(d => (byDate[d] || new Set()).forEach(sid => {
            const s = spans.get(sid);
            if (!s) spans.set(sid, { first: d, last: d });
            else { if (d < s.first) s.first = d; if (d > s.last) s.last = d; }
        }));
        (onRoster[cid] || new Map()).forEach((enrolled, sid) => {
            if (!latest) return;
            const s = spans.get(sid);
            if (s) { s.last = latest; if (enrolled && enrolled < s.first) s.first = enrolled; }
            else {
                // Never attended: from enrolment (or record creation), not before the first register.
                const joined = enrolled || joinedFallback[sid];
                if (!joined) return;
                const from = joined < days[0] ? days[0] : joined;
                if (from <= latest) spans.set(sid, { first: from, last: latest });
            }
        });
        let present = 0, expected = 0;
        days.forEach(d => {
            const p = byDate[d] ? byDate[d].size : 0;
            let inSpan = 0;
            spans.forEach(s => { if (s.first <= d && d <= s.last) inSpan++; });
            present += p;
            expected += Math.max(inSpan, p);
        });
        out[cid] = {
            sessions: days.length,
            present,
            expected,
            rate: expected > 0 ? Math.round((present / expected) * 100) : null,
            duplicatesIgnored: Math.max(0, (rawTicks[cid] || 0) - present),
        };
    });
    return out;
}
