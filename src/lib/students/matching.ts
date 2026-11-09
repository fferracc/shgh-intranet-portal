// Is this applicant already a student? (1 Oct 2026, Franco's rule)
// A match is: the same name (any capitals, extra spaces ignored) AND the same date of birth,
// or the same email, or the same mobile number.
// Date of birth is private (/studentsPrivate), so pass students with their private data
// overlaid; without it only email and mobile can match.

export type MatchReason = "name and date of birth" | "email" | "mobile";
export interface StudentMatch { student: Record<string, any> & { id: string }; reasons: MatchReason[] }

export const normName = (v: unknown) => String(v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
export const normEmail = (v: unknown) => String(v ?? "").trim().toLowerCase();

/** Digits only, with +44 / 0044 turned into a leading 0, so "+44 7700 900123" equals "07700900123". */
export function normMobile(v: unknown): string {
    let d = String(v ?? "").replace(/[^\d+]/g, "");
    if (d.startsWith("+44")) d = "0" + d.slice(3);
    else if (d.startsWith("0044")) d = "0" + d.slice(4);
    d = d.replace(/\D/g, "");
    if (d.startsWith("44") && d.length === 12) d = "0" + d.slice(2);
    return d.length >= 7 ? d : "";
}

/** "2001-03-09", "09/03/2001" and "9/3/2001" all become "2001-03-09". Anything else: "". */
export function normDob(v: unknown): string {
    const s = String(v ?? "").trim();
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
    if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/.exec(s); // UK order: day, month, year
    if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    return "";
}

export function applicantName(app: Record<string, any>): string {
    return `${app.firstName || ""} ${app.lastName || ""}`.trim() || String(app.name || "").trim();
}

export function findStudentMatches(app: Record<string, any>, students: (Record<string, any> & { id: string })[]): StudentMatch[] {
    const name = normName(applicantName(app));
    const dob = normDob(app.dob);
    const email = normEmail(app.email);
    const mobile = normMobile(app.mobile);
    const out: StudentMatch[] = [];
    for (const s of students) {
        const reasons: MatchReason[] = [];
        if (name && dob && normName(s.name) === name && normDob(s.dob) === dob) reasons.push("name and date of birth");
        if (email && normEmail(s.email) === email) reasons.push("email");
        if (mobile && normMobile(s.mobile) === mobile) reasons.push("mobile");
        if (reasons.length) out.push({ student: s, reasons });
    }
    // Strongest first: more reasons, then not archived.
    return out.sort((a, b) => b.reasons.length - a.reasons.length || Number(a.student.archived === true) - Number(b.student.archived === true));
}

const isEmpty = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (typeof v === "number" && v === 0);

/** The fields of `incoming` that the existing record has empty. */
export function fillEmpty(existing: Record<string, any>, incoming: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(incoming)) {
        if (isEmpty(v)) continue;
        if (isEmpty(existing[k])) out[k] = v;
    }
    return out;
}
