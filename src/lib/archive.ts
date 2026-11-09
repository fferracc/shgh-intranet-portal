// Keep history instead of deleting (30 Sep 2026, Franco's choice).
//
// Deleting a course, student, volunteer or badge used to remove only the main record and
// leave its roster, registers, assignments and earned badges behind, so counts on
// different pages drifted apart. Now nothing with history is deleted:
//   - a course is CANCELLED (status "Cancelled"); its roster and registers stay;
//   - a student is ARCHIVED (archived: true) and taken off the courses that are still
//     planned or running; past registers stay, so funder totals keep their history;
//   - a volunteer is ARCHIVED by the setPersonArchived server function, which also
//     suspends the login (never deletes it) and takes them off running courses;
//   - a badge is ARCHIVED: it is no longer awarded, and people keep the ones they earned.
// Everything can be restored. Shared statistics (src/lib/stats.ts) leave archived students
// and people out of CURRENT counts and keep them in historical totals.
import { collection, deleteField, doc, getDoc, getDocs, query, updateDoc, where, writeBatch } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "@/lib/firebase";

const now = () => new Date().toISOString();

/** A course is finished when it is Completed or Cancelled (any capitals). */
export function isFinishedCourse(status: unknown): boolean {
    const s = String(status || "").toLowerCase();
    return s === "completed" || s === "cancelled";
}

export async function cancelCourse(courseId: string, byUid: string): Promise<void> {
    await updateDoc(doc(db, "course", courseId), { status: "Cancelled", cancelledAt: now(), cancelledBy: byUid });
}

/**
 * Archives a student and removes them from courses that have not finished.
 * Returns how many current enrolments were ended.
 */
export async function archiveStudent(studentId: string, byUid: string): Promise<number> {
    // Everything in one batch (30 Sep 2026 review): either the student is archived AND off
    // their current courses, or nothing changes.
    const rows = await getDocs(query(collection(db, "courseRoster"), where("studentId", "==", studentId)));
    const batch = writeBatch(db);
    let ended = 0;
    for (const r of rows.docs) {
        const courseId = r.data().courseId;
        const course = courseId ? await getDoc(doc(db, "course", courseId)) : null;
        // Keep the enrolment on finished courses: it is part of that course's history.
        if (course && course.exists() && isFinishedCourse(course.data().status)) continue;
        batch.delete(r.ref);
        ended++;
    }
    batch.update(doc(db, "students", studentId), { archived: true, archivedAt: now(), archivedBy: byUid });
    await batch.commit();
    return ended;
}

export async function restoreStudent(studentId: string): Promise<void> {
    await updateDoc(doc(db, "students", studentId), { archived: false, archivedAt: deleteField(), archivedBy: deleteField(), restoredAt: now() });
}

/** Archives (archived = true) or restores a volunteer or staff member, on the server. */
export async function setPersonArchived(uid: string, archived: boolean): Promise<{ assignmentsEnded: number; loginSuspended: boolean }> {
    const call = httpsCallable(functions, "setPersonArchived");
    const res = await call({ uid, archived });
    return res.data as { assignmentsEnded: number; loginSuspended: boolean };
}

export async function setBadgeArchived(badgeId: string, archived: boolean, byUid: string): Promise<void> {
    await updateDoc(doc(db, "achievementsBadges", badgeId), archived
        ? { archived: true, archivedAt: now(), archivedBy: byUid }
        : { archived: false, archivedAt: deleteField(), archivedBy: deleteField() });
}
