// Saving a student from the Add / Edit form (1 Oct 2026).
import { addDoc, collection, doc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { mainStudentData, saveStudentPrivate } from "@/lib/studentPrivate";
import { buildStudentSave, StudentFormValues } from "./studentForm";

export interface SaveResult { id: string; main: Record<string, any>; priv: Record<string, any>; privateSaved: boolean }

/** Creates (no id) or updates a student. Only the form's own fields are written. */
export async function saveStudentForm(id: string | null, values: StudentFormValues, withPrivate: boolean): Promise<SaveResult> {
    const { main, priv } = buildStudentSave(values, withPrivate);
    const safeMain = mainStudentData(main); // never the private fields
    let studentId = id;
    if (studentId) {
        await updateDoc(doc(db, "students", studentId), safeMain);
    } else {
        const ref = await addDoc(collection(db, "students"), { ...safeMain, createdAt: new Date().toISOString() });
        studentId = ref.id;
    }
    const privateSaved = Object.keys(priv).length ? await saveStudentPrivate(studentId, priv) : true;
    return { id: studentId, main: safeMain, priv, privateSaved };
}
