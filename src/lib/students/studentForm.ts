// The student Add / Edit form, shared by the Students list and the student page (1 Oct 2026).
//
// The saved object is built from the form fields ONLY, never from what the screen shows
// (enrolledCourses, ids, values filled in from /studentsPrivate, archive fields...), so
// editing a student cannot copy screen data into the record.
// Private fields (dob, gpName, ethnicity, nationality, refugeeNumber) go only to
// /studentsPrivate (see src/lib/studentPrivate.ts, WRITE_TO_MAIN is false).
import { NATIONALITY_OPTIONS } from "@/lib/countries";
import { PRIVATE_STUDENT_FIELDS } from "@/lib/studentPrivate";

export type StudentFormValues = {
    name: string; email: string; age: number; postcode: string; mobile: string; itLevel: string;
    reason: string; sovereignReference: string;
    parentName: string; parentPhone: string; emergencyContact: string; allergies: string; photoConsent: boolean;
    // private
    dob: string; gpName: string; ethnicity: string; nationality: string; refugeeNumber: string;
    /** Extra fields typed by staff ("Additional information"), text only. */
    custom: Record<string, string>;
};

/** Fields the form edits directly (not custom). */
export const FORM_FIELDS = ["name", "email", "age", "postcode", "mobile", "itLevel", "reason", "sovereignReference",
    "parentName", "parentPhone", "emergencyContact", "allergies", "photoConsent",
    "dob", "gpName", "ethnicity", "nationality", "refugeeNumber"] as const;

/** Keys that are never shown or saved as "Additional information". */
export const SYSTEM_KEYS = new Set<string>([
    ...FORM_FIELDS, "id", "createdAt", "updatedAt", "enrolledCourses", "languageUsed", "applicationId", "applicationNumber",
    "applicationAnswers", "archived", "archivedAt", "archivedBy", "restoredAt", "studentId", "uid",
]);

export const PRIVATE_FIELDS: readonly string[] = PRIVATE_STUDENT_FIELDS;

export const ETHNICITY_GROUPS: { label: string; options: string[] }[] = [
    { label: "White", options: ["English, Welsh, Scottish, Northern Irish or British", "Irish", "Gypsy or Irish Traveller", "Roma", "Any other White background"] },
    { label: "Mixed or Multiple ethnic groups", options: ["White and Black Caribbean", "White and Black African", "White and Asian", "Any other Mixed or Multiple ethnic background"] },
    { label: "Asian or Asian British", options: ["Indian", "Pakistani", "Bangladeshi", "Chinese", "Any other Asian background"] },
    { label: "Black, Black British, Caribbean or African", options: ["Caribbean", "African", "Any other Black, Black British or Caribbean background"] },
    { label: "Other ethnic group", options: ["Arab", "Any other ethnic group"] },
];
const ETHNICITY_ALL = new Set([...ETHNICITY_GROUPS.flatMap(g => g.options), "Prefer not to say"]);

export const REASONS = ["Academic Support / Tutoring", "Skill Development (IT, Languages, etc.)", "Socialization / Making Friends",
    "Recreational / Extracurricular Activities", "Parental Requirement", "Other"];

/** Nationality choices: the country list (with Stateless and Prefer not to say). */
export const NATIONALITIES = NATIONALITY_OPTIONS;
const NATIONALITY_SET = new Set(NATIONALITY_OPTIONS);

/** A stored value that is not on the list (old continent values such as "African"). */
export const isOldNationality = (v: unknown) => !!v && !NATIONALITY_SET.has(String(v));
export const isOldEthnicity = (v: unknown) => !!v && !ETHNICITY_ALL.has(String(v));

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));

/**
 * Custom fields of a record that the form can edit: keys outside the form and system keys,
 * with a text value. Numbers, yes/no values, lists and maps are left as they are (not saved).
 */
export function customFieldsOf(s: Record<string, any> | null | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (!s) return out;
    for (const [k, v] of Object.entries(s)) {
        if (SYSTEM_KEYS.has(k) || typeof v !== "string") continue;
        out[k] = v;
    }
    return out;
}

/** Every extra field of a record, as text, for display. */
export function extraFieldRows(s: Record<string, any> | null | undefined): { key: string; label: string; value: string }[] {
    if (!s) return [];
    return Object.entries(s)
        .filter(([k, v]) => !SYSTEM_KEYS.has(k) && v !== null && v !== undefined && v !== "")
        .map(([k, v]) => ({
            key: k, label: keyLabel(k),
            value: typeof v === "boolean" ? (v ? "Yes" : "No")
                : Array.isArray(v) ? v.map(x => String(x)).join(", ")
                : typeof v === "object" ? (typeof (v as any).toDate === "function" ? (v as any).toDate().toLocaleDateString("en-GB") : Object.entries(v).map(([a, b]) => `${a}: ${b}`).join("; "))
                : String(v),
        }));
}

export function emptyStudentForm(): StudentFormValues {
    return {
        name: "", email: "", age: 0, postcode: "", mobile: "", itLevel: "", reason: "", sovereignReference: "",
        parentName: "", parentPhone: "", emergencyContact: "", allergies: "", photoConsent: false,
        dob: "", gpName: "", ethnicity: "", nationality: "", refugeeNumber: "", custom: {},
    };
}

/** The form values for an existing student (with its private fields already overlaid). */
export function formFromStudent(s: Record<string, any>): StudentFormValues {
    return {
        name: str(s.name), email: str(s.email), age: Number(s.age) || 0, postcode: str(s.postcode), mobile: str(s.mobile),
        itLevel: str(s.itLevel), reason: str(s.reason), sovereignReference: str(s.sovereignReference),
        parentName: str(s.parentName), parentPhone: str(s.parentPhone), emergencyContact: str(s.emergencyContact),
        allergies: str(s.allergies), photoConsent: s.photoConsent === true,
        dob: str(s.dob), gpName: str(s.gpName), ethnicity: str(s.ethnicity), nationality: str(s.nationality), refugeeNumber: str(s.refugeeNumber),
        custom: customFieldsOf(s),
    };
}

/**
 * What to save. `main` goes to /students (never holds private fields), `priv` to /studentsPrivate.
 * Without permission to see private fields, `priv` is empty so nothing private is overwritten.
 */
export function buildStudentSave(f: StudentFormValues, withPrivate: boolean): { main: Record<string, any>; priv: Record<string, any> } {
    const main: Record<string, any> = {
        name: f.name.trim(), email: f.email.trim(), age: Number(f.age) || 0, postcode: f.postcode.trim(), mobile: f.mobile.trim(),
        itLevel: f.itLevel, reason: f.reason, sovereignReference: f.sovereignReference.trim(),
        parentName: f.parentName.trim(), parentPhone: f.parentPhone.trim(), emergencyContact: f.emergencyContact.trim(),
        allergies: f.allergies.trim(), photoConsent: !!f.photoConsent,
    };
    for (const [k, v] of Object.entries(f.custom)) {
        const key = k.trim();
        if (!key || SYSTEM_KEYS.has(key) || /[./\[\]*`~]/.test(key)) continue;
        main[key] = String(v ?? "");
    }
    const priv: Record<string, any> = {};
    if (withPrivate) {
        priv.dob = f.dob; priv.gpName = f.gpName.trim(); priv.ethnicity = f.ethnicity;
        priv.nationality = f.nationality; priv.refugeeNumber = f.refugeeNumber.trim();
    }
    return { main, priv };
}

/** Age in whole years from a date of birth, or 0. */
export function ageFromDob(dob: string | undefined): number {
    if (!dob) return 0;
    const birth = new Date(dob);
    if (isNaN(birth.getTime())) return 0;
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const m = today.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
    return age;
}

/** A label for a field key: "parentPhone" -> "Parent Phone". */
export const keyLabel = (k: string) => k.replace(/([A-Z])/g, " $1").replace(/^./, c => c.toUpperCase()).trim();
