// Shared course helpers (25 Sep 2026).
import { collection, doc, getDocs, runTransaction } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Course } from "@/lib/types";

/** Course types. "1-2-1" = a volunteer helping one person; reported as session notes, no attendance. */
export const COURSE_TYPES: { value: NonNullable<Course["type"]>; label: string; hint: string }[] = [
    { value: "Rolling", label: "Rolling", hint: "Regular class with a fixed group. Attendance is taken." },
    { value: "Drop-in", label: "Drop-in", hint: "People come when they can. Attendance is taken, no attendance rate." },
    { value: "1-2-1", label: "1-2-1", hint: "A volunteer helps one person. Each session is logged with notes, no attendance." },
];

export const isOneToOne = (c: { type?: string } | null | undefined) => c?.type === "1-2-1";

export function emptyCourse(): Partial<Course> {
    return {
        code: "", name: "", description: "", type: "Rolling",
        schedule: { day: "Monday", start: "10:00", end: "12:00", frequency: "Weekly" },
        startDate: "", endDate: "", setting: "In-Person", venue: "", address: "", postcode: "", status: "Planned",
    };
}

/** One line describing when a course runs. */
export function describeSchedule(c: Partial<Course>): string {
    if (isOneToOne(c)) return "Sessions arranged between the volunteer and the person";
    const s = c.schedule;
    if (!s) return "No schedule set";
    if (s.frequency === "Custom" && s.customNotes) return s.customNotes;
    return `${s.frequency || "Weekly"}, ${s.day || ""} ${s.start || ""} to ${s.end || ""}`.trim();
}

/**
 * Creates a course. If no code is given, the next free code (C0001, C0002, ...) is
 * taken from counters/courseCounter, never lower than the highest code already used,
 * so codes typed by hand in the past cannot clash.
 */
export async function createCourse(data: Partial<Course>): Promise<{ id: string; code: string }> {
    const existing = await getDocs(collection(db, "course"));
    let highest = 0;
    existing.forEach(d => {
        const m = /^C(\d+)$/i.exec(String(d.data().code || ""));
        if (m) highest = Math.max(highest, Number(m[1]));
    });
    const counterRef = doc(db, "counters", "courseCounter");
    const courseRef = doc(collection(db, "course"));
    const code = await runTransaction(db, async tx => {
        let chosen = (data.code || "").trim();
        if (!chosen) {
            const snap = await tx.get(counterRef);
            const current = snap.exists() ? Number(snap.data().currentNumber) || 0 : 0;
            const next = Math.max(current, highest) + 1;
            tx.set(counterRef, { currentNumber: next }, { merge: true });
            chosen = `C${String(next).padStart(4, "0")}`;
        }
        tx.set(courseRef, { ...data, code: chosen, createdAt: new Date().toISOString() });
        return chosen;
    });
    return { id: courseRef.id, code };
}
