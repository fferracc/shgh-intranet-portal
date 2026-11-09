// Volunteer application form (25 Sep 2026). The questions are the ones on the
// Microsoft Form "Sovereign House GH Volunteer Registration Form" that the website's
// role pages link to, so applicants see the same thing. Added: phone (optional, for
// the interview), CV upload (PDF, required since 28 Sep 2026, up to 3 MB), a consent tick,
// nationality (private, 28 Sep) and a short personal motivation paragraph (28 Sep).
// IMPORTANT: firestore.rules checks these keys and options. Change both together.

export const VOLUNTEER_ROLES = ["Social media, PR & Website", "Fundraiser", "Bookkeeper", "IT Teacher", "IT Support Assistant"];
export const GENDERS = ["Female", "Male"];
export const ETHNICITIES = ["Black African, Caribbean or British", "Mixed/Multiple identities", "Asian or Asian British", "White (Any white background)", "Prefer not to say", "Other"];
export const DISABILITY = ["Yes", "No", "Living with a long term health condition", "Prefer not to say"];
export const HEARD_FROM = ["Flyers", "Website", "Friends and family", "Community centre", "University/College", "Email", "Social Media", "Other"];
export const AGREEMENT = ["A Little", "Some", "A Lot"];
export const MOTIVATIONS: { key: string; text: string }[] = [
    { key: "practicalSkills", text: "I would like to gain new practical skills." },
    { key: "lifeSkills", text: "I would like to gain improved life / social skills." },
    { key: "confidence", text: "I would like to increase my confidence." },
    { key: "employment", text: "I hope it would help to improve my employment options and opportunities." },
    { key: "university", text: "I hope it might help me at university or college." },
    { key: "engaged", text: "I hope it might help me to feel more engaged with my work or study." },
    { key: "leadership", text: "I would like to improve my leadership skills." },
    { key: "learning", text: "I want to keep on learning." },
    { key: "interests", text: "I hope it might spark some new interests." },
    { key: "meetPeople", text: "I hope I might meet some new people." },
];
// The ten statements grouped for the chart on the application page (29 Sep 2026).
// Colours are the validated categorical slots 1 to 4, in fixed order.
export const AGREEMENT_SCORE: Record<string, number> = { "A Little": 1, "Some": 2, "A Lot": 3 };
export const MOTIVATION_SHORT: Record<string, string> = {
    practicalSkills: "Practical skills", lifeSkills: "Life / social skills", leadership: "Leadership",
    confidence: "Confidence", learning: "Keep on learning", interests: "New interests",
    employment: "Employment", university: "University / college", engaged: "Engaged with work / study",
    meetPeople: "Meet new people",
};
export const MOTIVATION_GROUPS: { name: string; color: string; keys: string[] }[] = [
    { name: "Skills", color: "#2a78d6", keys: ["practicalSkills", "lifeSkills", "leadership"] },
    { name: "Confidence and growth", color: "#eb6834", keys: ["confidence", "learning", "interests"] },
    { name: "Career and study", color: "#1baf7a", keys: ["employment", "university", "engaged"] },
    { name: "Social", color: "#eda100", keys: ["meetPeople"] },
];
export const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const SLOTS = ["09:00 to 10:00", "10:00 to 11:00", "11:00 to 12:00", "12:00 to 13:00", "13:00 to 14:00", "14:00 to 15:00",
    "15:00 to 16:00", "16:00 to 17:00", "17:00 to 18:00", "18:00 to 19:00", "19:00 to 20:00"];

export const CV_MAX_BYTES = 3 * 1024 * 1024;
export const MOTIVATION_TEXT_MAX = 1500;
export const MOTIVATION_TEXT_MIN = 30;

export type VolunteerStatus = "new" | "interview" | "accepted" | "declined";
export const STATUS_LABEL: Record<VolunteerStatus, string> = {
    new: "New", interview: "Interview booked", accepted: "Accepted", declined: "Declined",
};

export interface VolunteerApplicationDoc {
    id: string;
    name: string; email: string; phone?: string; age: string; gender: string; role: string;
    heardFrom: string; heardFromOther?: string;
    motivations: Record<string, string>;
    motivationText?: string;
    availability: Record<string, string[]>;
    cvPath?: string; cvName?: string;
    consent: boolean; status: VolunteerStatus; submittedAt?: any;
    interview?: { start: string; durationMinutes: number; location: string; notes?: string; invitedBy?: string; invitedByName?: string; invitedAt?: string };
    decision?: { by: string; at: string; outcome: "accepted" | "declined"; courseId?: string; userId?: string };
}

/** The interview has happened (its end time is in the past) and nobody has decided yet. */
export function awaitingDecision(a: Pick<VolunteerApplicationDoc, "status" | "interview">, now = new Date()): boolean {
    if (a.status !== "interview" || !a.interview?.start) return false;
    const end = new Date(new Date(a.interview.start).getTime() + (a.interview.durationMinutes || 30) * 60000);
    return end < now;
}
