// STUDENT APPLICATIONS (1 Oct 2026). Loaded by index.js (FEATURE MODULES).
//
// studentApplicationReceived: a new answer to a portal-hosted student form
// (applicationProcesses/{procId}/submissions/{subId} in shgh-lms1):
//   1. emails the staff alert list, recruitmentSettings/studentAlerts {emails}; with no list
//      saved: all admins and super admins plus everyone with the student_applications
//      permission (not archived);
//   2. if the application has an email address, sends the applicant (or parent) a copy of
//      what they sent, with the question wording they saw (the stored `labels`).
// Both are written to the `mail` collection; sendQueuedMail sends them from recruitment@.
// Forms that live in the refugees-appform Firebase project are not seen by this function.
//
// 6 Oct 2026:
//   * applications MOVED from the old database (importedFrom set) send no email at all;
//   * a referral (formType "referral") sends its copy to the person who referred
//     (answers.referrerEmail), not to the participant;
//   * studentDeclineEmail (callable): after someone with Student Applications marks an
//     application Declined and ticks "send a polite email", queues that email once.
"use strict";

const FROM = "recruitment@sovereignhousegh.com";
const PORTAL = "https://shgh-portal.web.app";
const valid = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || ""));
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
const para = (t) => `<p>${esc(t).replace(/\n/g, "<br>")}</p>`;

// Top-level answers in the order the forms ask them (src/lib/formTemplates.ts STUDENT_TOP_KEYS),
// with a fallback wording for old submissions without labels.
const TOP_KEYS = [
    ["programme", "Programme"], ["name", "Name"], ["dob", "Date of birth"], ["yearClass", "Year / Class"],
    ["gender", "Gender"], ["school", "Current school"], ["nationality", "Nationality"], ["parentName", "Parent / Guardian's name"],
    ["address", "Address"], ["postcode", "Postcode"], ["mobile", "Mobile number"], ["email", "Email"],
    ["emergencyContactName", "Emergency contact name"], ["emergencyContactPhone", "Emergency contact phone"], ["itLevel", "IT level"],
];

function answerText(v) {
    if (v == null) return "";
    if (Array.isArray(v)) return v.map(String).join(", ");
    if (typeof v === "object") return Object.entries(v).map(([a, b]) => `${a}: ${Array.isArray(b) ? b.join(", ") : b}`).join("; ");
    return String(v);
}

// "2014-03-09" -> "9 March 2014"
function ukDate(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ""));
    if (!m) return String(v || "");
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

// Questions added in the form editor (answers map), with the wording the applicant saw.
function extraAnswerLines(answers, labels) {
    if (!answers || typeof answers !== "object") return [];
    const q = (labels && labels.questions) || {};
    return Object.entries(answers)
        .filter(([k, v]) => !(k.endsWith("Other") && !v))
        .map(([k, v]) => {
            const base = k.endsWith("Other") ? k.slice(0, -5) : k;
            const label = k.endsWith("Other") ? `${q[base] || base} (other)` : (q[k] || k);
            return `${label}: ${answerText(v) || "No answer"}`;
        });
}

// Top-level answers as "Question: answer" lines, in form order.
function topAnswerLines(a) {
    const q = (a.labels && a.labels.questions) || {};
    const lines = [];
    for (const [key, fallback] of TOP_KEYS) {
        const v = a[key];
        if (v == null || v === "") continue;
        lines.push(`${q[key] || fallback}: ${key === "dob" ? ukDate(v) : answerText(v)}`);
    }
    return lines;
}

module.exports = (ctx) => {
    const { admin, db, onDocumentCreated, userCan } = ctx;

    async function alertList() {
        try {
            const cfg = await db.collection("recruitmentSettings").doc("studentAlerts").get();
            if (cfg.exists && Array.isArray(cfg.data().emails)) {
                const list = cfg.data().emails.map((e) => String(e).trim().toLowerCase()).filter(valid);
                if (list.length) return [...new Set(list)];
            }
        } catch (e) { console.warn("[studentApps] alert list", e.message); }
        // No list saved: admins, super admins and anyone with Student Applications, not archived.
        const users = await db.collection("users").get();
        const out = users.docs.map((d) => d.data())
            .filter((u) => u && u.archived !== true
                && (u.role === "admin" || u.role === "super_admin" || (typeof userCan === "function" && userCan(u, "student_applications"))))
            .map((u) => String(u.email || "").trim().toLowerCase())
            .filter(valid);
        return [...new Set(out)];
    }

    // The polite email to a declined applicant (or the parent / the referrer), sent once.
    const studentDeclineEmail = ctx.onCall(async (request) => {
        const { HttpsError } = ctx;
        if (!request.auth) throw new HttpsError("unauthenticated", "You must be signed in.");
        const caller = await ctx.callerProfile(request.auth.uid);
        if (!userCan(caller, "student_applications")) throw new HttpsError("permission-denied", "You need the Student Applications permission.");
        const procId = String((request.data && request.data.processId) || "");
        const subId = String((request.data && request.data.submissionId) || "");
        if (!/^[A-Za-z0-9]{6,40}$/.test(procId) || !/^[A-Za-z0-9_-]{6,60}$/.test(subId)) throw new HttpsError("invalid-argument", "Unknown application.");
        const procSnap = await db.collection("applicationProcesses").doc(procId).get();
        if (!procSnap.exists) throw new HttpsError("not-found", "Unknown application process.");
        const ref = db.collection("applicationProcesses").doc(procId).collection("submissions").doc(subId);
        const snap = await ref.get();
        if (!snap.exists) throw new HttpsError("not-found", "Unknown application.");
        const a = snap.data() || {};
        if (String(a.status || "").toLowerCase() !== "declined") throw new HttpsError("failed-precondition", "Mark the application Declined first.");
        if (a.declineEmailAt) return { sent: false, already: true };
        const isReferral = a.formType === "referral";
        const ans = (a.answers && typeof a.answers === "object") ? a.answers : {};
        const email = String((isReferral ? ans.referrerEmail : a.email) || "").trim().toLowerCase();
        if (!valid(email)) throw new HttpsError("failed-precondition", "This application has no email address.");
        const proc = procSnap.data() || {};
        const course = String(proc.title || "the course").trim();
        const name = String(a.name || `${a.firstName || ""} ${a.lastName || ""}`).trim() || "the applicant";
        const forChild = a.formType === "children" || !!a.parentName;
        const greet = isReferral ? String(ans.referrerName || "") : (forChild && a.parentName ? a.parentName : name);
        const first = String(greet).trim().split(/\s+/)[0] || "there";
        const body = isReferral
            ? `Thank you for referring ${name} to ${course}. Unfortunately we are not able to offer ${name} a place on this course at the moment.\n\nWe would be glad to receive a referral again for a future course.`
            : forChild
                ? `Thank you for applying for ${name} to join ${course}. Unfortunately we are not able to offer a place on this course at the moment.\n\nWe would be glad to hear from you again for a future course.`
                : `Thank you for applying to ${course}. Unfortunately we are not able to offer you a place on this course at the moment.\n\nWe would be glad to hear from you again for a future course.`;
        const text = `Dear ${first},\n\n${body}\n\nBest regards,\nSovereign House GH Team`;
        await db.collection("systemMail").add({
            to: [email], cc: [], from: FROM, status: "queued", createdBy: request.auth.uid,
            createdAt: admin.firestore.FieldValue.serverTimestamp(), processId: procId, submissionId: subId,
            subject: `Your application to Sovereign House GH: ${course}`.slice(0, 300),
            text, html: text.split("\n\n").map(para).join(""), kind: "student-application-declined",
        });
        await ref.update({ declineEmailAt: admin.firestore.FieldValue.serverTimestamp(), declineEmailBy: request.auth.uid });
        return { sent: true };
    });

    return {
        studentDeclineEmail,
        studentApplicationReceived: onDocumentCreated(
            { document: "applicationProcesses/{procId}/submissions/{subId}", region: "europe-west2" },
            async (event) => {
                const a = event.data && event.data.data();
                if (!a) return;
                if (a.importedFrom) return; // moved from the old database: no alerts, no copies
                const { procId, subId } = event.params;
                let proc = {};
                try {
                    const p = await db.collection("applicationProcesses").doc(procId).get();
                    if (p.exists) proc = p.data() || {};
                } catch (e) { console.warn("[studentApps] process", e.message); }

                const formTitle = String(proc.title || (a.labels && a.labels.title) || "student").trim();
                const name = String(a.name || `${a.firstName || ""} ${a.lastName || ""}`).trim() || "an applicant";
                const now = admin.firestore.FieldValue.serverTimestamp();
                const common = { cc: [], from: FROM, status: "queued", createdBy: "system", createdAt: now, processId: procId, submissionId: subId };

                // 1. The alert to the team. Kept short: the details are in the portal.
                const to = await alertList();
                if (to.length) {
                    const link = `${PORTAL}/recruitment/students/detail?id=${procId}`;
                    const lines = [
                        `Name: ${name}`,
                        ...(a.programme ? [`Programme: ${a.programme}`] : []),
                        ...(a.parentName ? [`Parent / guardian: ${a.parentName}`] : []),
                        `Email given: ${valid(a.email) ? "yes" : "no"}`,
                    ];
                    const text = `A new application has arrived for ${formTitle}.\n\n${lines.join("\n")}\n\nOpen it in the portal: ${link}`;
                    const html = text.split("\n\n").map(para).join("").replace(esc(link), `<a href="${link}">${esc(link)}</a>`);
                    await db.collection("systemMail").add({
                        ...common, to, subject: `New ${formTitle} application from ${name}`.slice(0, 300),
                        text, html, kind: "student-application-alert",
                    });
                }

                // 2. The applicant's (or parent's) own copy. A referral: the referrer's copy.
                const isReferral = a.formType === "referral";
                const ans = (a.answers && typeof a.answers === "object") ? a.answers : {};
                const email = String((isReferral ? ans.referrerEmail : a.email) || "").trim().toLowerCase();
                if (!valid(email)) return;
                if (ctx.allowApplicantCopy && !(await ctx.allowApplicantCopy(email))) { console.warn("[studentApps] copy skipped: daily limit for this address"); return; }
                const forChild = a.formType === "children" || !!a.parentName;
                const greetName = isReferral ? String(ans.referrerName || "there") : (forChild && a.parentName ? a.parentName : name);
                const first = String(greetName).trim().split(/\s+/)[0] || "there";
                const sections = [
                    { title: "Your answers", lines: topAnswerLines(a) },
                    ...(extraAnswerLines(a.answers, a.labels).length ? [{ title: "Your other answers", lines: extraAnswerLines(a.answers, a.labels) }] : []),
                ];
                const intro = isReferral
                    ? `Dear ${first},\n\nThank you for referring ${name} to ${formTitle} at Sovereign House GH. We have received the referral and our team will contact ${name} directly.\n\nHere is a copy of what you sent us.`
                    : forChild
                    ? `Dear ${first},\n\nThank you for applying for ${name} to join ${formTitle} at Sovereign House GH. We have received the application and we will be in touch soon.\n\nHere is a copy of what you sent us.`
                    : `Dear ${first},\n\nThank you for applying to ${formTitle} at Sovereign House GH. We have received your application and we will be in touch soon.\n\nHere is a copy of what you sent us.`;
                const outro = "If anything here is not right, just reply to this email and let us know.\n\nBest regards,\nSovereign House GH Team";
                const text = [intro, ...sections.map((s) => [s.title, ...s.lines].join("\n")), outro].join("\n\n");
                const html = intro.split("\n\n").map(para).join("")
                    + sections.map((s) => `<h3 style="margin:18px 0 6px;font-size:15px;color:#1e293b">${esc(s.title)}</h3>` + para(s.lines.join("\n"))).join("")
                    + outro.split("\n\n").map(para).join("");
                await db.collection("systemMail").add({
                    ...common, to: [email], subject: (isReferral ? `Your referral to Sovereign House GH: ${name}` : `Your application to Sovereign House GH: ${formTitle}`).slice(0, 300),
                    text, html, kind: "student-application-copy",
                });
            }),
    };
};
