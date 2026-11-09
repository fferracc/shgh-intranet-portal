// Application forms that live inside the portal (25 Sep 2026).
// Questions copied from the forms linked on sovereignhousegh.com/uk (Google Forms),
// so applicants see the same questions as before. Field keys use the names the
// student record already uses (name, dob, email, mobile, postcode, parentName,
// parentPhone, emergencyContact) so "Accept" turns an application into a student
// without any re-typing.
//
// Submissions are saved in applicationProcesses/{processId}/submissions, which the
// Student Applications dashboard already reads (collectionName is set to that path).
// IMPORTANT: firestore.rules lists every allowed key (APPLICATION_ALLOWED_KEYS below).
// Adding a field here means adding it to the rule too, or submissions are refused.

export type FieldType = "text" | "email" | "tel" | "date" | "select" | "radio" | "textarea";

export interface FormField {
    key: string;
    label: string;
    type: FieldType;
    required?: boolean;
    options?: string[];
    help?: string;
    maxLength?: number;
}

export interface ApplicationFormDef {
    id: "children" | "adults";
    title: string;
    audience: string;
    intro: string;
    fields: FormField[];
}

const SAFE_LIST_HELP = "Please add clpadmin@sovereignhousegh.education to your safe list and check your spam folder regularly, so our emails reach you.";

export const APPLICATION_FORMS: Record<ApplicationFormDef["id"], ApplicationFormDef> = {
    children: {
        id: "children",
        title: "Children's & Young Adults Application Form",
        audience: "Children",
        intro: "Our Computer Learning Programme provides a gateway for children and young adults to develop essential digital skills. Please fill in this form as the child's parent or guardian.",
        fields: [
            { key: "programme", label: "Preferred programme", type: "select", required: true, options: [
                "In-person Salford Classes - M6 5QQ",
                "In-person Bury Classes - BL9 0RU",
                "Online Children's Classes (11-16 years only)",
                "AI & Robotics Club",
                "Creative Digital Media Course",
                "Unsure",
            ] },
            { key: "name", label: "Child's name", type: "text", required: true, maxLength: 120 },
            { key: "dob", label: "Date of birth", type: "date", required: true },
            { key: "yearClass", label: "Year / Class", type: "text", required: true, maxLength: 60 },
            { key: "gender", label: "Gender", type: "radio", required: true, options: ["Male", "Female"] },
            { key: "school", label: "Current school", type: "text", required: true, maxLength: 150 },
            { key: "parentName", label: "Parent / Guardian's name", type: "text", required: true, maxLength: 120 },
            { key: "address", label: "Address of Parent / Guardian", type: "text", required: true, maxLength: 300 },
            { key: "postcode", label: "Post code", type: "text", required: true, maxLength: 12 },
            { key: "mobile", label: "Mobile number", type: "tel", required: true, maxLength: 30 },
            { key: "email", label: "Your email", type: "email", required: true, maxLength: 150, help: SAFE_LIST_HELP },
            { key: "emergencyContactName", label: "Name of secondary emergency contact", type: "text", required: true, maxLength: 120 },
            { key: "emergencyContactPhone", label: "Telephone number of emergency contact", type: "tel", required: true, maxLength: 30 },
        ],
    },
    adults: {
        id: "adults",
        title: "Adults Digital Skills Application Form",
        audience: "Adults",
        intro: "The Computer Learning Programme offers adults the opportunity to build a positive skill set and gain confidence in their abilities.",
        fields: [
            { key: "name", label: "Applicant's name", type: "text", required: true, maxLength: 120 },
            { key: "dob", label: "Date of birth", type: "date", required: true },
            { key: "gender", label: "Gender", type: "radio", required: true, options: ["Male", "Female"] },
            { key: "postcode", label: "Post code", type: "text", required: true, maxLength: 12 },
            { key: "mobile", label: "Mobile number", type: "tel", required: true, maxLength: 30 },
            { key: "email", label: "Your email", type: "email", required: true, maxLength: 150, help: SAFE_LIST_HELP },
            { key: "emergencyContactPhone", label: "Telephone number of emergency contact", type: "tel", required: true, maxLength: 30 },
            { key: "programme", label: "Please choose a suitable option for the classes", type: "select", required: true, options: [
                "50+ In-person Bury Classes",
                "50+ In-person Salford Classes",
                "Asylum Seekers and Refugees",
                "Creative Digital Media Course",
                "Unsure",
                "Other",
            ] },
        ],
    },
};

export const PORTAL_FORM_IDS = Object.keys(APPLICATION_FORMS) as ApplicationFormDef["id"][];

/** Keys the security rules accept on a submission. Keep in step with firestore.rules. */
export const APPLICATION_ALLOWED_KEYS = [
    "processId", "formType", "status", "submittedAt", "consent",
    "programme", "name", "dob", "yearClass", "gender", "school", "parentName", "parentPhone",
    "address", "postcode", "mobile", "email", "emergencyContactName", "emergencyContactPhone",
    "emergencyContact", "nationality", "itLevel", "age", "answers", "labels",
];

/** Public address of a portal form. */
export function publicFormUrl(processId: string): string {
    const origin = typeof window !== "undefined" ? window.location.origin : "https://shgh-portal.web.app";
    return `${origin}/apply?p=${processId}`;
}

/** Firestore path the dashboard reads for a portal form's submissions. */
export function submissionsPath(processId: string): string {
    return `applicationProcesses/${processId}/submissions`;
}
