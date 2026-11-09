// Editable application forms (29 Sep 2026).
//
// Every public form (volunteer + the three student forms) is described by a template.
// The built-in templates below are the forms as they were; a super admin can change
// them at /recruitment/forms, which saves formTemplates/{id}. Public pages read the
// saved template and fall back to the built-in one.
//
// Where answers are stored:
//   * "top keys" (the fields the volunteer / student record already uses) are saved as
//     top-level fields, so Accept keeps copying them into the new record;
//   * any question added in the editor gets an id like q_ab12cd and is saved in the
//     `answers` map; volunteer questions marked private go to private/equality.answers;
//   * every submission also keeps `labels` (the wording the person actually saw), so
//     old applications stay readable after the form is edited.
// firestore.rules checks the top keys and the answers / labels maps. Change both together.
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { AGREEMENT, DISABILITY, ETHNICITIES, GENDERS, HEARD_FROM, MOTIVATION_GROUPS, MOTIVATION_TEXT_MAX, MOTIVATION_TEXT_MIN, MOTIVATIONS, VOLUNTEER_ROLES } from "@/lib/volunteerForm";

export type FormId = "volunteer" | "children" | "adults" | "refugees" | "referral";
export const STUDENT_FORM_IDS: Exclude<FormId, "volunteer">[] = ["children", "adults", "refugees", "referral"];
export const ALL_FORM_IDS: FormId[] = ["volunteer", ...STUDENT_FORM_IDS];

export type QType = "text" | "email" | "tel" | "number" | "date" | "select" | "radio" | "checkboxes" | "textarea"
    | "country" | "likert" | "availability" | "cv";
/** Types a super admin can give a question in the editor. The others belong to core questions. */
export const EDITABLE_TYPES: { type: QType; label: string }[] = [
    { type: "text", label: "Short answer" },
    { type: "textarea", label: "Paragraph" },
    { type: "radio", label: "One choice (buttons)" },
    { type: "select", label: "One choice (drop-down)" },
    { type: "checkboxes", label: "Several choices (tick boxes)" },
    { type: "number", label: "Number" },
    { type: "date", label: "Date" },
    { type: "email", label: "Email" },
    { type: "tel", label: "Phone number" },
];
export const TYPE_LABEL: Record<QType, string> = {
    text: "Short answer", textarea: "Paragraph", radio: "One choice (buttons)", select: "One choice (drop-down)",
    checkboxes: "Several choices", number: "Number", date: "Date", email: "Email", tel: "Phone number",
    country: "Country list", likert: "Statements (A Little / Some / A Lot)", availability: "Weekly availability", cv: "CV upload (PDF)",
};

export interface Statement { id: string; text: string; group?: string }
export interface Question {
    id: string;
    type: QType;
    label: string;
    help?: string;
    required?: boolean;
    options?: string[];     // radio / select / checkboxes (without "Other")
    other?: boolean;        // adds "Other" with a text box; saved as <id>Other
    maxLength?: number;
    minLength?: number;
    private?: boolean;      // volunteer only: saved in private/equality
    core?: boolean;         // cannot be deleted, type fixed
    lockRequired?: boolean; // must stay required
    statements?: Statement[]; // likert
    scale?: string[];       // likert
}
export interface FormGroup { name: string; color: string }
export interface FormTemplate {
    id: FormId;
    kind: "volunteer" | "student";
    name: string;          // short name for lists
    title: string;
    intro: string;
    consent: string;
    thankYou: string;
    questions: Question[];
    groups?: FormGroup[];  // likert chart categories (volunteer)
    updatedAt?: string;
    updatedBy?: string;
    updatedByName?: string;
}

/** Categorical colours, validated set, fixed order (used for statement groups). */
export const GROUP_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"];

/** Answers saved as top-level fields (they map onto the record Accept creates). */
export const VOLUNTEER_TOP_KEYS = ["name", "email", "phone", "age", "gender", "role", "heardFrom", "motivations", "motivationText", "availability"];
export const VOLUNTEER_PRIVATE_KEYS = ["nationality", "ethnicity", "disability"];
export const STUDENT_TOP_KEYS = ["programme", "name", "dob", "yearClass", "gender", "school", "parentName", "parentPhone",
    "address", "postcode", "mobile", "email", "emergencyContactName", "emergencyContactPhone", "nationality", "itLevel", "age"];

// ---------------------------------------------------------------------------
// DATABASE LIMITS (1 Oct 2026). The same numbers as firestore.rules validVolunteerApplication
// and validSubmission: an answer longer than these is refused by the database, so the editor
// cannot set a longer "Longest answer" and the forms cut answers to them. Change both together.
// ---------------------------------------------------------------------------
export const DB_LIMITS: Record<"volunteer" | "student", Record<string, number>> = {
    volunteer: {
        name: 120, email: 150, phone: 30, age: 3, gender: 200, role: 200, heardFrom: 200, motivationText: 3000,
        nationality: 80, ethnicity: 200, disability: 200,
    },
    student: {
        programme: 200, name: 120, dob: 10, yearClass: 60, gender: 200, school: 150, parentName: 120, parentPhone: 30,
        address: 300, postcode: 12, mobile: 30, email: 150, emergencyContactName: 120, emergencyContactPhone: 30,
        nationality: 80, itLevel: 200, age: 3,
    },
};
/** The "Other, please describe" box (heardFromOther, ethnicityOther: 120 in the rules). */
export const OTHER_TEXT_MAX = 120;
/** The answers map holds at most 60 entries (a question with "Other" uses two). */
export const ANSWERS_MAX = 60;
/** The statements map (motivations) holds at most 40 entries. */
export const STATEMENTS_MAX = 40;
/** formTemplates documents hold at most 80 questions. */
export const QUESTIONS_MAX = 80;
/** Added questions are not checked one by one in the rules; these keep them sensible. */
export const EXTRA_TEXT_MAX: Partial<Record<QType, number>> = { text: 500, textarea: 3000, email: 150, tel: 30, number: 12 };
export const DEFAULT_MAX: Partial<Record<QType, number>> = { text: 200, textarea: 1500, email: 150, tel: 30, number: 6 };

const kindOf = (id: FormId): "volunteer" | "student" => id === "volunteer" ? "volunteer" : "student";

/** Is this question saved as a top-level field (checked one by one by the rules)? */
export function isTopKey(formId: FormId, qid: string): boolean {
    return formId === "volunteer" ? (VOLUNTEER_TOP_KEYS.includes(qid) || VOLUNTEER_PRIVATE_KEYS.includes(qid)) : STUDENT_TOP_KEYS.includes(qid);
}

/** The longest answer the database accepts for this question, or undefined for no fixed limit. */
export function dbLimit(formId: FormId, q: Pick<Question, "id" | "type">): number | undefined {
    const top = DB_LIMITS[kindOf(formId)][q.id];
    if (top !== undefined && isTopKey(formId, q.id)) return top;
    return EXTRA_TEXT_MAX[q.type];
}

/** How many entries this form puts in each answers map (the rule allows 60 each). */
export function answerSlots(t: FormTemplate): { public: number; private: number } {
    let pub = 0, priv = 0;
    for (const q of t.questions) {
        if (q.type === "cv") continue;
        const n = 1 + (q.other ? 1 : 0);
        if (t.id === "volunteer") {
            if (VOLUNTEER_TOP_KEYS.includes(q.id) || VOLUNTEER_PRIVATE_KEYS.includes(q.id)) continue;
            if (q.private) priv += n; else pub += n;
        } else {
            if (STUDENT_TOP_KEYS.includes(q.id)) { if (q.type === "checkboxes") pub += 1; if (q.other) pub += 1; continue; }
            pub += n;
        }
    }
    return { public: pub, private: priv };
}

/** Everything in a template the database would refuse. Empty when it can be saved. */
export function limitProblems(t: FormTemplate): string[] {
    const out: string[] = [];
    if (t.questions.length > QUESTIONS_MAX) out.push(`A form can have at most ${QUESTIONS_MAX} questions (this one has ${t.questions.length}).`);
    const slots = answerSlots(t);
    if (slots.public > ANSWERS_MAX) out.push(`Too many added questions: the database keeps at most ${ANSWERS_MAX} added answers per application and this form needs ${slots.public} (a question with "Other" counts twice).`);
    if (slots.private > ANSWERS_MAX) out.push(`Too many private questions: at most ${ANSWERS_MAX} private answers (this form needs ${slots.private}).`);
    t.questions.forEach((q, i) => {
        const lim = dbLimit(t.id, q);
        if (lim !== undefined && q.maxLength && q.maxLength > lim) out.push(`Question ${i + 1} ("${q.label}"): the longest answer can be at most ${lim} characters, the database limit.`);
        if (q.minLength && lim !== undefined && q.minLength > (q.maxLength || lim)) out.push(`Question ${i + 1}: the shortest answer is longer than the longest answer.`);
        if (lim !== undefined && isTopKey(t.id, q.id) && ["radio", "select"].includes(q.type)) {
            const long = (q.options || []).map(o => o.trim()).filter(o => o.length > lim);
            if (long.length) out.push(`Question ${i + 1}: the option "${long[0].slice(0, 40)}…" is longer than the ${lim} characters the database keeps for this answer.`);
        }
        if (q.type === "likert" && (q.statements || []).length > STATEMENTS_MAX) out.push(`Question ${i + 1}: at most ${STATEMENTS_MAX} statements (there are ${(q.statements || []).length}).`);
    });
    return out;
}

/** Cut every "Longest answer" to the database limit, so an old saved template can never ask for more. */
function clampLimits(t: FormTemplate): FormTemplate {
    t.questions = t.questions.map(q => {
        const lim = dbLimit(t.id, q);
        if (lim === undefined) return q;
        const max = Math.min(q.maxLength || DEFAULT_MAX[q.type] || lim, lim);
        return { ...q, maxLength: max, ...(q.minLength && q.minLength > max ? { minLength: max } : {}) };
    });
    return t;
}

const SAFE_LIST_HELP = "Please add clpadmin@sovereignhousegh.education to your safe list and check your spam folder regularly, so our emails reach you.";
const noOther = (list: string[]) => list.filter(o => o !== "Other");

const VOLUNTEER: FormTemplate = {
    id: "volunteer", kind: "volunteer", name: "Volunteer",
    title: "Sovereign House GH Volunteer Registration Form",
    intro: "Thank you for wanting to help. It takes about five minutes.",
    consent: "I agree that Sovereign House GH can keep these details and my CV to process my application and to contact me about volunteering.",
    thankYou: "Our team will review it and email you from recruitment@sovereignhousegh.com. Please add that address to your safe list and check your spam folder.",
    groups: MOTIVATION_GROUPS.map(g => ({ name: g.name, color: g.color })),
    questions: [
        { id: "name", type: "text", label: "Name", required: true, maxLength: 120, core: true, lockRequired: true },
        { id: "email", type: "email", label: "Email", required: true, maxLength: 150, core: true, lockRequired: true },
        { id: "phone", type: "tel", label: "Phone number", help: "In case we need to call you about your interview.", required: false, maxLength: 30, core: true },
        { id: "age", type: "number", label: "Age", required: true, maxLength: 3, core: true },
        { id: "gender", type: "radio", label: "Gender", required: true, options: GENDERS, core: true },
        { id: "nationality", type: "country", label: "Nationality", help: "Kept private.", required: true, private: true, core: true },
        { id: "ethnicity", type: "radio", label: "Ethnicity", help: "Only used, anonymously, to report on the diversity of our volunteers. Kept private.", required: true, options: noOther(ETHNICITIES), other: true, private: true, core: true },
        { id: "disability", type: "radio", label: "Do you consider yourself to have a disability?", help: "Kept private. It helps us make any adjustments you may need.", required: true, options: DISABILITY, private: true, core: true },
        { id: "role", type: "radio", label: "Which role are you volunteering for?", required: true, options: VOLUNTEER_ROLES, core: true },
        { id: "heardFrom", type: "radio", label: "How did you hear about Sovereign House GH?", required: true, options: noOther(HEARD_FROM), other: true, core: true },
        {
            id: "motivations", type: "likert", label: "How well do you agree with these statements about volunteering?", required: true, core: true, scale: AGREEMENT,
            statements: MOTIVATIONS.map(m => ({ id: m.key, text: m.text, group: MOTIVATION_GROUPS.find(g => g.keys.includes(m.key))?.name })),
        },
        {
            id: "motivationText", type: "textarea", label: "In your own words, what truly moves you to volunteer with us?", core: true, required: true,
            help: "Tell us in a few sentences what you care about most, what drives you, and how giving your time here connects with the kind of life and purpose you want. There are no right or wrong answers.",
            minLength: MOTIVATION_TEXT_MIN, maxLength: MOTIVATION_TEXT_MAX,
        },
        { id: "availability", type: "availability", label: "Your weekly availability", help: "Tap every hour you are usually free. We require attendance at least once a week unless discussed otherwise.", required: true, core: true, lockRequired: true },
        { id: "cv", type: "cv", label: "Your CV", help: "PDF file only, up to 3 MB.", required: true, core: true, lockRequired: true },
    ],
};

const STUDENT_CONSENT = "I agree that Sovereign House GH can keep these details to process this application and to contact me about the course.";
const STUDENT_THANKS = "Our team will review it and contact you by email or phone. Please add clpadmin@sovereignhousegh.education to your safe list and check your spam folder.";

const CHILDREN: FormTemplate = {
    id: "children", kind: "student", name: "Children & Young Adults",
    title: "Children's & Young Adults Application Form",
    intro: "Our Computer Learning Programme provides a gateway for children and young adults to develop essential digital skills. Please fill in this form as the child's parent or guardian.",
    consent: STUDENT_CONSENT, thankYou: STUDENT_THANKS,
    questions: [
        { id: "programme", type: "select", label: "Preferred programme", required: true, options: [
            "In-person Salford Classes - M6 5QQ", "In-person Bury Classes - BL9 0RU", "Online Children's Classes (11-16 years only)",
            "AI & Robotics Club", "Creative Digital Media Course", "Unsure"] },
        { id: "name", type: "text", label: "Child's name", required: true, maxLength: 120, core: true, lockRequired: true },
        { id: "dob", type: "date", label: "Date of birth", required: true, core: true },
        { id: "yearClass", type: "text", label: "Year / Class", required: true, maxLength: 60 },
        { id: "gender", type: "radio", label: "Gender", required: true, options: ["Male", "Female"] },
        { id: "school", type: "text", label: "Current school", required: true, maxLength: 150 },
        { id: "parentName", type: "text", label: "Parent / Guardian's name", required: true, maxLength: 120, core: true },
        { id: "address", type: "text", label: "Address of Parent / Guardian", required: true, maxLength: 300 },
        { id: "postcode", type: "text", label: "Post code", required: true, maxLength: 12, core: true },
        { id: "mobile", type: "tel", label: "Mobile number", required: true, maxLength: 30, core: true },
        { id: "email", type: "email", label: "Your email", required: true, maxLength: 150, help: SAFE_LIST_HELP, core: true },
        { id: "emergencyContactName", type: "text", label: "Name of secondary emergency contact", required: true, maxLength: 120, core: true },
        { id: "emergencyContactPhone", type: "tel", label: "Telephone number of emergency contact", required: true, maxLength: 30, core: true },
    ],
};

const ADULTS: FormTemplate = {
    id: "adults", kind: "student", name: "Adults 50+",
    title: "Adults Digital Skills Application Form",
    intro: "The Computer Learning Programme offers adults the opportunity to build a positive skill set and gain confidence in their abilities.",
    consent: STUDENT_CONSENT, thankYou: STUDENT_THANKS,
    questions: [
        { id: "name", type: "text", label: "Applicant's name", required: true, maxLength: 120, core: true, lockRequired: true },
        { id: "dob", type: "date", label: "Date of birth", required: true, core: true },
        { id: "gender", type: "radio", label: "Gender", required: true, options: ["Male", "Female"] },
        { id: "postcode", type: "text", label: "Post code", required: true, maxLength: 12, core: true },
        { id: "mobile", type: "tel", label: "Mobile number", required: true, maxLength: 30, core: true },
        { id: "email", type: "email", label: "Your email", required: true, maxLength: 150, help: SAFE_LIST_HELP, core: true },
        { id: "emergencyContactPhone", type: "tel", label: "Telephone number of emergency contact", required: true, maxLength: 30, core: true },
        { id: "programme", type: "select", label: "Please choose a suitable option for the classes", required: true, options: [
            "50+ In-person Bury Classes", "50+ In-person Salford Classes", "Asylum Seekers and Refugees", "Creative Digital Media Course", "Unsure"], other: true },
    ],
};

// Built from the old refugees-appform forms (Salford "applications" and Bury "BuryApplications"):
// name, nationality, postcode, date of birth, email, mobile and IT level. The two sites are one
// question here.
const REFUGEES: FormTemplate = {
    id: "refugees", kind: "student", name: "Refugees & Asylum Seekers",
    title: "Refugees & Asylum Seekers Application Form",
    intro: "Free digital skills classes for refugees and asylum seekers. Please fill in this form and we will contact you about the next class.",
    consent: STUDENT_CONSENT, thankYou: "Thank you. Our team will contact you by phone or email about the next class.",
    questions: [
        { id: "name", type: "text", label: "Full name", required: true, maxLength: 120, core: true, lockRequired: true },
        { id: "nationality", type: "country", label: "Nationality", required: true, core: true },
        { id: "postcode", type: "text", label: "Postcode", required: true, maxLength: 12, core: true },
        { id: "dob", type: "date", label: "Date of birth", required: true, core: true },
        { id: "email", type: "email", label: "Email address", required: false, maxLength: 150, core: true },
        { id: "mobile", type: "tel", label: "Mobile number", required: true, maxLength: 30, core: true },
        { id: "programme", type: "radio", label: "Where would you like to attend?", required: true, options: ["Salford", "Bury"] },
        { id: "itLevel", type: "radio", label: "IT level", required: true, options: ["Beginner", "Intermediate", "Advanced"] },
    ],
};

// Moved from the old refugees-appform "referrals" form (6 Oct 2026): a partner agency, council or job
// centre refers an adult. The participant's details are top-level (Accept copies them); who referred
// them is in the answers map under fixed ids, so the alert and the student record show it.
const REFERRAL: FormTemplate = {
    id: "referral", kind: "student", name: "Digital Skills Referral",
    title: "Digital Skills Referral Form",
    intro: "For referral agencies and partner organisations. Use this form to refer an adult to our digital skills programme. It takes about two minutes.",
    consent: "I confirm the participant knows about this referral and agrees to Sovereign House GH contacting them about the digital skills programme.",
    thankYou: "Referral received, thank you. Our team will contact the participant directly. You can send another referral with the same link.",
    questions: [
        { id: "name", type: "text", label: "Participant's full name", required: true, maxLength: 120, core: true, lockRequired: true },
        { id: "age", type: "number", label: "Age", required: true, maxLength: 3, core: true },
        { id: "postcode", type: "text", label: "Postcode", required: true, maxLength: 12, core: true },
        { id: "nationality", type: "country", label: "Nationality", required: true, core: true },
        { id: "mobile", type: "tel", label: "Participant's phone number", required: true, maxLength: 30, core: true },
        { id: "email", type: "email", label: "Participant's email address (if they have one)", required: false, maxLength: 150, core: true },
        { id: "beneficiaryGroups", type: "checkboxes", label: "Which of these describe the participant?", help: "Tick all that apply.", required: true,
          options: ["Asylum seeker or refugee", "Adult 50+", "Adult seeking skills for work"] },
        { id: "itLevel", type: "radio", label: "Level of digital skills", help: "Your best estimate is fine.", required: true, options: ["Beginner", "Intermediate", "Advanced"] },
        { id: "referralOrg", type: "text", label: "Referring agency / organisation", required: true, maxLength: 200, core: true },
        { id: "referrerName", type: "text", label: "Name of person referring", required: true, maxLength: 120, core: true },
        { id: "referrerEmail", type: "email", label: "Your email (so we can update you)", required: false, maxLength: 150, core: true },
        { id: "comments", type: "textarea", label: "Comments about the participant", help: "Anything that would help us support them: access needs, language, availability, goals.", required: false, maxLength: 1500 },
    ],
};

export const DEFAULT_TEMPLATES: Record<FormId, FormTemplate> = { volunteer: VOLUNTEER, children: CHILDREN, adults: ADULTS, refugees: REFUGEES, referral: REFERRAL };

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

/** A saved template, made safe: core questions can never go missing, and their type and flags stay fixed. */
export function resolveTemplate(id: FormId, saved?: Partial<FormTemplate> | null): FormTemplate {
    const base = clone(DEFAULT_TEMPLATES[id]);
    if (!saved || !Array.isArray(saved.questions)) return clampLimits(base);
    const coreById = new Map(base.questions.filter(q => q.core).map(q => [q.id, q]));
    const qs: Question[] = [];
    const seen = new Set<string>();
    for (const q of saved.questions as Question[]) {
        if (!q || !q.id || seen.has(q.id)) continue;
        seen.add(q.id);
        const core = coreById.get(q.id);
        if (core) qs.push({ ...q, type: core.type, core: true, lockRequired: core.lockRequired, private: core.private, required: core.lockRequired ? true : q.required, scale: core.scale });
        else qs.push({ ...q, core: false, lockRequired: false });
    }
    coreById.forEach((q, qid) => { if (!seen.has(qid)) qs.push(q); });
    return clampLimits({
        ...base,
        title: saved.title || base.title, intro: saved.intro ?? base.intro,
        consent: saved.consent || base.consent, thankYou: saved.thankYou || base.thankYou,
        groups: saved.groups && saved.groups.length ? saved.groups : base.groups,
        questions: qs, updatedAt: saved.updatedAt, updatedBy: saved.updatedBy, updatedByName: saved.updatedByName,
    });
}

export async function loadTemplate(id: FormId): Promise<FormTemplate> {
    try {
        const s = await getDoc(doc(db, "formTemplates", id));
        return resolveTemplate(id, s.exists() ? (s.data() as Partial<FormTemplate>) : null);
    } catch { return resolveTemplate(id, null); }
}

export const newQuestionId = () => "q_" + Math.random().toString(36).slice(2, 8);
export const newStatementId = () => "s_" + Math.random().toString(36).slice(2, 8);

/** The wording the applicant saw, saved with the submission. */
export function labelsOf(t: FormTemplate) {
    const questions: Record<string, string> = {};
    const statements: Record<string, string> = {};
    const groups: Record<string, string> = {};
    t.questions.forEach(q => {
        questions[q.id] = q.label;
        (q.statements || []).forEach(s => { statements[s.id] = s.text; if (s.group) groups[s.id] = s.group; });
    });
    return { questions, statements, groups, title: t.title };
}

export type Answer = string | string[] | Record<string, string> | Record<string, string[]>;
export type SubmissionLabels = ReturnType<typeof labelsOf>;

/** Is this question answered well enough to submit? Returns an error text or "". */
export function checkAnswer(q: Question, v: Answer | undefined, extra: Record<string, string>): string {
    const empty = v === undefined || v === null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length)
        || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);
    if (q.type === "cv") return "";
    if (q.type === "likert") {
        const m = (v || {}) as Record<string, string>;
        if (q.required && (q.statements || []).some(s => !m[s.id])) return q.label;
        return "";
    }
    if (q.type === "availability") {
        const m = (v || {}) as Record<string, string[]>;
        if (q.required && !Object.values(m).some(a => a && a.length)) return q.label;
        return "";
    }
    if (q.required && empty) return q.label;
    if (typeof v === "string" && q.minLength && v.trim() && v.trim().length < q.minLength) return `${q.label} (at least ${q.minLength} characters)`;
    if (q.required && q.minLength && typeof v === "string" && v.trim().length < q.minLength) return `${q.label} (at least ${q.minLength} characters)`;
    if (q.other && v === "Other" && !(extra[q.id + "Other"] || "").trim()) return `${q.label} (please describe)`;
    if (q.type === "email" && typeof v === "string" && v.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim())) return `${q.label} (check the address)`;
    return "";
}

function cleanAnswer(q: Question, v: Answer | undefined): Answer {
    if (q.type === "likert") {
        const m = (v || {}) as Record<string, string>;
        const out: Record<string, string> = {};
        (q.statements || []).forEach(s => { if (m[s.id]) out[s.id] = String(m[s.id]).slice(0, 40); });
        return out;
    }
    if (q.type === "availability") return (v || {}) as Record<string, string[]>;
    if (q.type === "checkboxes") return (Array.isArray(v) ? v : []).map(x => String(x).slice(0, 200)).slice(0, 30);
    let s = typeof v === "string" ? v.trim() : "";
    if (q.type === "email") s = s.toLowerCase();
    // maxLength is already cut to the database limit by resolveTemplate.
    return s.slice(0, q.maxLength || DEFAULT_MAX[q.type] || 200);
}

/** Split a volunteer form's answers into the application document and its private part. */
export function buildVolunteerSubmission(t: FormTemplate, values: Record<string, Answer>, extras: Record<string, string>) {
    const top: Record<string, unknown> = {};
    const answers: Record<string, Answer> = {};
    const priv: Record<string, unknown> = {};
    const privAnswers: Record<string, Answer> = {};
    for (const q of t.questions) {
        if (q.type === "cv") continue;
        const val = cleanAnswer(q, values[q.id]);
        const otherText = q.other && val === "Other" ? String(extras[q.id + "Other"] || "").trim().slice(0, OTHER_TEXT_MAX) : "";
        if (VOLUNTEER_TOP_KEYS.includes(q.id)) {
            top[q.id] = val;
            if (q.id === "heardFrom") top.heardFromOther = otherText;
        } else if (VOLUNTEER_PRIVATE_KEYS.includes(q.id)) {
            priv[q.id] = val;
            if (q.id === "ethnicity") priv.ethnicityOther = otherText;
        } else if (q.private) {
            privAnswers[q.id] = val;
            if (q.other) privAnswers[q.id + "Other"] = otherText;
        } else {
            answers[q.id] = val;
            if (q.other) answers[q.id + "Other"] = otherText;
        }
    }
    top.answers = answers;
    top.labels = labelsOf(t);
    priv.answers = privAnswers;
    return { top, priv };
}

/** A student form's answers as one submission document. */
export function buildStudentSubmission(t: FormTemplate, values: Record<string, Answer>, extras: Record<string, string>) {
    const top: Record<string, unknown> = {};
    const answers: Record<string, Answer> = {};
    for (const q of t.questions) {
        const val = cleanAnswer(q, values[q.id]);
        const otherText = q.other && val === "Other" ? String(extras[q.id + "Other"] || "").trim().slice(0, OTHER_TEXT_MAX) : "";
        if (STUDENT_TOP_KEYS.includes(q.id) && typeof val === "string") top[q.id] = val;
        else answers[q.id] = val;
        if (q.other && otherText) answers[q.id + "Other"] = otherText;
    }
    if (t.id === "children" && top.mobile && !top.parentPhone) top.parentPhone = top.mobile;
    const ec = [top.emergencyContactName, top.emergencyContactPhone].filter(Boolean).join(", ");
    if (ec) top.emergencyContact = ec;
    top.answers = answers;
    top.labels = labelsOf(t);
    return top;
}

/** Answers that are not top-level fields, with the question wording, for the detail pages and emails. */
export function extraAnswerRows(answers: Record<string, unknown> | undefined, labels: Partial<SubmissionLabels> | undefined): { label: string; value: string }[] {
    if (!answers) return [];
    const q = labels?.questions || {};
    return Object.entries(answers)
        .filter(([k, v]) => !(k.endsWith("Other") && !v))
        .map(([k, v]) => {
            const baseId = k.endsWith("Other") ? k.slice(0, -5) : k;
            const label = k.endsWith("Other") ? `${q[baseId] || baseId} (other)` : (q[k] || k);
            const value = Array.isArray(v) ? v.join(", ") : typeof v === "object" && v ? Object.entries(v as Record<string, unknown>).map(([a, b]) => `${a}: ${b}`).join("; ") : String(v ?? "");
            return { label, value: value || "No answer" };
        });
}
