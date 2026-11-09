// Loads the collections that src/lib/stats.ts works on. Each read is separate, so a read the
// rules refuse (or a network error) is reported in `failed` instead of silently becoming 0.
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { StatsData } from "@/lib/stats";

export type StatsPart = "courses" | "students" | "users" | "roster" | "assignments" | "attendance" | "oneToOne" | "activities";

const COLLECTION: Record<StatsPart, string> = {
    courses: "course",
    students: "students",
    users: "users",
    roster: "courseRoster",
    assignments: "courseAssignments",
    attendance: "attendanceRecords",
    oneToOne: "oneToOneSessions",
    activities: "volunteerActivities",
};

export async function loadStatsData(parts: StatsPart[]): Promise<{ data: StatsData; failed: StatsPart[] }> {
    const data: StatsData = { courses: [] };
    const failed: StatsPart[] = [];
    await Promise.all(parts.map(async p => {
        try {
            // Only approved hours count, and that is the query the rules allow for everyone with access.
            const ref = p === "activities"
                ? query(collection(db, COLLECTION[p]), where("status", "==", "approved"))
                : collection(db, COLLECTION[p]);
            const snap = await getDocs(ref);
            (data as any)[p] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        } catch (e) {
            console.warn(`Could not read ${COLLECTION[p]}`, e);
            failed.push(p);
        }
    }));
    return { data, failed };
}
