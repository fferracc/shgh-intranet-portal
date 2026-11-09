// Student safeguarding split (see project notes "student split").
// The five sensitive fields below are being moved from /students/{id}
// to /studentsPrivate/{id}. Only staff, admins and people with the
// "students" permission can read /studentsPrivate.
//
// PHASE 2 (now): every write goes to BOTH places, every read uses the
// /students value when present and falls back to /studentsPrivate.
// Old copies of the UK app still write only to /students, so /students
// wins while both exist.
// PHASE 3 (30 Sep 2026): WRITE_TO_MAIN is false. The server function
// studentPrivateFields moves the five fields out of /students whenever anything
// (an old phone included) writes them there, and the one-off privateDataCleanup
// function (run by a super admin after the deploy) empties the existing records.
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";

export const PRIVATE_STUDENT_FIELDS = ["gpName", "dob", "ethnicity", "nationality", "refugeeNumber"] as const;
export type PrivateStudentField = typeof PRIVATE_STUDENT_FIELDS[number];

/** Phase 3 (30 Sep 2026): private fields are written only to /studentsPrivate. */
export const WRITE_TO_MAIN: boolean = false;

type Data = Record<string, any>;

/** Only the private fields that are present in `data`. */
export function pickPrivate(data: Data): Data {
    const out: Data = {};
    for (const f of PRIVATE_STUDENT_FIELDS) {
        if (data && data[f] !== undefined) out[f] = data[f];
    }
    return out;
}

/** The data to write to /students (drops the private fields once phase 3 starts). */
export function mainStudentData<T extends Data>(data: T): T {
    if (WRITE_TO_MAIN) return data;
    const copy: Data = { ...data };
    for (const f of PRIVATE_STUDENT_FIELDS) delete copy[f];
    return copy as T;
}

/** Fill any private field missing from the student record with the private copy. */
export function overlayPrivate<T extends Data>(student: T, priv: Data | null | undefined): T {
    if (!priv) return student;
    const out: Data = { ...student };
    for (const f of PRIVATE_STUDENT_FIELDS) {
        const mainVal = out[f];
        if ((mainVal === undefined || mainVal === null || mainVal === "") && priv[f] !== undefined) {
            out[f] = priv[f];
        }
    }
    return out as T;
}

/** All private records keyed by student id, or null if this user may not read them. */
export async function loadStudentPrivateMap(): Promise<Map<string, Data> | null> {
    try {
        const snap = await getDocs(collection(db, "studentsPrivate"));
        const map = new Map<string, Data>();
        snap.forEach(d => map.set(d.id, d.data()));
        return map;
    } catch (err) {
        console.warn("[studentsPrivate] not readable for this user", err);
        return null;
    }
}

/** One private record, or null if missing or not readable. */
export async function loadStudentPrivate(id: string): Promise<Data | null> {
    try {
        const snap = await getDoc(doc(db, "studentsPrivate", id));
        return snap.exists() ? snap.data() : null;
    } catch (err) {
        console.warn("[studentsPrivate] not readable for this user", err);
        return null;
    }
}

/** Mirror the private fields of `data` into /studentsPrivate/{id}. Never throws. */
export async function saveStudentPrivate(id: string, data: Data): Promise<boolean> {
    const priv = pickPrivate(data);
    if (!id || Object.keys(priv).length === 0) return true;
    try {
        await setDoc(doc(db, "studentsPrivate", id), { ...priv, updatedAt: serverTimestamp() }, { merge: true });
        return true;
    } catch (err) {
        console.warn("[studentsPrivate] could not save private fields for", id, err);
        return false;
    }
}

/** Remove the private record when a student is deleted. Never throws. */
export async function deleteStudentPrivate(id: string): Promise<void> {
    try {
        await deleteDoc(doc(db, "studentsPrivate", id));
    } catch (err) {
        console.warn("[studentsPrivate] could not delete private record for", id, err);
    }
}
