// Recruitment emails (25 Sep 2026). The portal never sends mail itself: it writes a
// message to the `mail` collection and the server function `sendQueuedMail` sends it
// from recruitment@sovereignhousegh.com. Until that mailbox is connected, messages
// wait in the queue and the application page offers "Open in Outlook" and
// "Download invite" so nothing is blocked.
import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";

export const RECRUITMENT_FROM = "recruitment@sovereignhousegh.com";
const APP_VIDEO = "https://youtu.be/MebCgBC4edg";
const APP_APK = "https://shgh-lms1.web.app/app-updates/uk/uk-app.apk";
const APP_WEB = "https://shgh-lms1.web.app/";

export interface QueuedMail {
    to: string[]; cc?: string[]; subject: string; html: string; text: string;
    ics?: string; icsName?: string; kind: string; applicationId?: string;
}

const esc = (s: string) => String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
const paras = (text: string) => text.split("\n\n").map(p => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
const firstName = (name: string) => (name || "").trim().split(/\s+/)[0] || "there";

export interface Recipients { to: string[]; cc: string[] }

/** The ticked addresses as To and Copy: the applicant (if ticked) is To, everyone else a copy. */
export function splitRecipients(applicantEmail: string, ticked: string[]): Recipients {
    const clean = [...new Set(ticked.map(e => e.trim().toLowerCase()).filter(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))];
    const applicant = applicantEmail.trim().toLowerCase();
    if (clean.includes(applicant)) return { to: [applicant], cc: clean.filter(e => e !== applicant) };
    return { to: clean, cc: [] };
}

export function formatWhen(startIso: string): string {
    const d = new Date(startIso);
    return d.toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
}

/** A calendar invitation (.ics) the recipient can accept into Outlook or any calendar.
 *  An UPDATE (1 Oct 2026) is the same event: the same UID as the first invite, a higher
 *  SEQUENCE and METHOD:REQUEST, so Outlook and Google move the meeting instead of adding a second one. */
export function buildIcs(opts: { uid: string; startIso: string; durationMinutes: number; title: string; location: string; description: string; attendees: string[]; sequence?: number }): string {
    const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const start = new Date(opts.startIso);
    const end = new Date(start.getTime() + opts.durationMinutes * 60000);
    const esc = (s: string) => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
    // Lines longer than 75 octets are folded (RFC 5545), which some calendars insist on.
    const fold = (line: string) => {
        const out: string[] = [];
        let rest = line;
        while (new TextEncoder().encode(rest).length > 75) {
            let cut = 74;
            while (new TextEncoder().encode(rest.slice(0, cut)).length > 74) cut--;
            if (/[\uD800-\uDBFF]/.test(rest.charAt(cut - 1))) cut--; // never split an emoji in two
            out.push(rest.slice(0, cut));
            rest = " " + rest.slice(cut);
        }
        out.push(rest);
        return out.join("\r\n");
    };
    const uid = opts.uid.includes("@") ? opts.uid : `${opts.uid}@sovereignhousegh.com`;
    const seq = Math.max(0, Math.floor(opts.sequence || 0));
    return [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Sovereign House GH//Portal//EN", "METHOD:REQUEST", "CALSCALE:GREGORIAN",
        "BEGIN:VEVENT",
        `UID:${uid}`,
        `SEQUENCE:${seq}`,
        `DTSTAMP:${fmt(new Date())}`,
        `DTSTART:${fmt(start)}`,
        `DTEND:${fmt(end)}`,
        `SUMMARY:${esc(opts.title)}`,
        `LOCATION:${esc(opts.location)}`,
        `DESCRIPTION:${esc(opts.description)}`,
        `ORGANIZER;CN=Sovereign House GH:mailto:${RECRUITMENT_FROM}`,
        ...opts.attendees.map(a => `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a}`),
        "STATUS:CONFIRMED",
        "END:VEVENT", "END:VCALENDAR", "",
    ].map(fold).join("\r\n");
}

/** The calendar UID of an application's interview. Invites sent before 1 Oct 2026 used
 *  interview-<id>-<start in ms>, which is rebuilt from the booked start so an update still matches. */
export function interviewIcsUid(app: { id: string; interviewIcsUid?: string; interview?: { start: string } | null }): string {
    if (app.interviewIcsUid) return app.interviewIcsUid;
    if (app.interview?.start && !isNaN(Date.parse(app.interview.start))) return `interview-${app.id}-${Date.parse(app.interview.start)}@sovereignhousegh.com`;
    return `interview-${app.id}-${Date.now()}@sovereignhousegh.com`;
}

type Who = { id: string; name: string; email: string; role: string };
type Interview = { start: string; durationMinutes: number; location: string; notes?: string };

function interviewIcs(app: Who, iv: Interview, rcpt: Recipients, cal: { uid: string; sequence: number }) {
    return buildIcs({
        uid: cal.uid, sequence: cal.sequence, startIso: iv.start, durationMinutes: iv.durationMinutes,
        title: `Volunteer interview: ${app.name} (${app.role})`, location: iv.location,
        description: `Volunteer interview with Sovereign House GH.${iv.notes ? `\n${iv.notes}` : ""}`,
        attendees: [...rcpt.to, ...rcpt.cc],
    });
}

export function interviewInvite(app: Who, iv: Interview, rcpt: Recipients, cal?: { uid: string; sequence: number }): QueuedMail {
    const when = formatWhen(iv.start);
    const text = `Dear ${firstName(app.name)},

Thank you for applying to volunteer with Sovereign House GH as ${app.role}. We would like to invite you to a short interview.

When: ${when} (${iv.durationMinutes} minutes)
Where: ${iv.location}${iv.notes ? `\n\n${iv.notes}` : ""}

A calendar invitation is attached. Please accept it, or reply to this email if the time does not suit you and we will find another one.

Best regards,
Sovereign House GH Team`;
    return {
        to: rcpt.to, cc: rcpt.cc,
        subject: `Interview invitation: volunteering with Sovereign House GH`,
        text, html: paras(text), kind: "interview", applicationId: app.id,
        icsName: "interview.ics",
        ics: interviewIcs(app, iv, rcpt, cal || { uid: `interview-${app.id}-${Date.parse(iv.start)}`, sequence: 0 }),
    };
}

/** A changed interview (1 Oct 2026): a short email and the same calendar event, moved.
 *  Sent with kind "interview", the only interview kind the mail rules accept. */
export function interviewUpdate(app: Who, iv: Interview, rcpt: Recipients, cal: { uid: string; sequence: number }, previousStart?: string): QueuedMail {
    const when = formatWhen(iv.start);
    const moved = !previousStart || Date.parse(previousStart) !== Date.parse(iv.start);
    const text = `Dear ${firstName(app.name)},

${moved ? `Your interview has moved to ${when}.` : `The details of your interview on ${when} have changed.`}

When: ${when} (${iv.durationMinutes} minutes)
Where: ${iv.location}${iv.notes ? `\n\n${iv.notes}` : ""}

The attached calendar invitation updates the one we sent before. Please accept it, or reply to this email if the new time does not suit you.

Best regards,
Sovereign House GH Team`;
    return {
        to: rcpt.to, cc: rcpt.cc,
        subject: moved ? `Your interview has moved to ${when}` : "Your interview details have changed",
        text, html: paras(text), kind: "interview", applicationId: app.id,
        icsName: "interview.ics",
        ics: interviewIcs(app, iv, rcpt, cal),
    };
}

export function declineEmail(app: { id: string; name: string; email: string; role: string }, rcpt?: Recipients): QueuedMail {
    const text = `Dear ${firstName(app.name)},

Thank you very much for your interest in volunteering with Sovereign House GH as ${app.role}, and for the time you gave to your application.

After careful consideration, we are not able to offer you a volunteering place at this time. This is not a reflection of your value, and we would be glad to hear from you again in the future as our needs change.

We wish you every success.

Best regards,
Sovereign House GH Team`;
    return { to: rcpt?.to || [app.email], cc: rcpt?.cc || [], subject: "Your volunteer application with Sovereign House GH", text, html: paras(text), kind: "declined", applicationId: app.id };
}

/** The welcome text is now written by the server (functions/recruitment.js welcomeText, with the
 *  password link in it) when acceptVolunteerApplication runs. Kept here as the reference copy:
 *  change both together. */
export function welcomeEmail(app: { id: string; name: string; email: string; role: string }, courseLine?: string, rcpt?: Recipients): QueuedMail {
    const text = `Dear ${firstName(app.name)},

Congratulations! We are delighted to welcome you to Sovereign House GH as ${app.role}.

${courseLine ? courseLine : "You will be assigned to a course soon, and we will let you know the details."}

Your login for our LMS App
Email: ${app.email}
Password: you will receive a separate email with a link to create your own password. Please check your spam or junk folder if you cannot find it. If the link has expired, open the app, tap "Forgot Password?" on the login screen and enter your email to get a new one.

Get started
Video tutorial: ${APP_VIDEO}
Android app: ${APP_APK}
Web app (iPhone, tablet or computer): ${APP_WEB}

To install on Android, open the app link on your phone, download the file and tap it to install. If your phone asks, allow installing apps from this source. The app keeps itself up to date.

We highly encourage you to read our official policies inside the app.

Best regards,
Sovereign House GH Team`;
    return { to: rcpt?.to || [app.email], cc: rcpt?.cc || [], subject: "Welcome to Sovereign House GH: your volunteer place and app details", text, html: paras(text), kind: "welcome", applicationId: app.id };
}

export async function queueMail(m: QueuedMail, createdBy: string): Promise<string> {
    const ref = await addDoc(collection(db, "mail"), { ...m, cc: m.cc || [], from: RECRUITMENT_FROM, status: "queued", createdBy, createdAt: serverTimestamp() });
    return ref.id;
}

/** Outlook-ready link for sending a queued message by hand. */
export function mailtoLink(m: Pick<QueuedMail, "to" | "cc" | "subject" | "text">): string {
    const q = new URLSearchParams();
    if (m.cc && m.cc.length) q.set("cc", m.cc.join(","));
    q.set("subject", m.subject);
    q.set("body", m.text);
    return `mailto:${m.to.join(",")}?${q.toString().replace(/\+/g, "%20")}`;
}
