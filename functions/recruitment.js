// ---------------------------------------------------------------------------
// VOLUNTEER RECRUITMENT, server side (30 Sep 2026). Loaded by index.js (FEATURE MODULES).
//
// acceptVolunteerApplication  Accept as ONE server step. Each step is recorded on the
//                             application under acceptSteps {account, profile, course, welcome}
//                             with a timestamp, so pressing Accept again resumes at the first
//                             missing step and never repeats one that already ran.
// getVolunteerCvForVolunteer  The CV of an accepted volunteer, for the Volunteers pages
//                             (Volunteers or Volunteer Applications permission).
// cleanupOrphanCvs            Daily 04:00 UK time: deletes CVs older than 24 hours whose
//                             application no longer exists (a form that failed after the upload,
//                             or an application deleted by hand). Touches nothing else.
//
// The welcome email text is the one in src/lib/recruitmentMail.ts (welcomeEmail). Functions
// cannot import TypeScript, so it is written out again below: change both together.
// ---------------------------------------------------------------------------
module.exports = (ctx) => {
    const { admin, db, onCall, HttpsError, onSchedule, userCan, callerProfile } = ctx;

    const FROM = "recruitment@sovereignhousegh.com";
    const APP_VIDEO = "https://youtu.be/MebCgBC4edg";
    const APP_APK = "https://shgh-lms1.web.app/app-updates/uk/uk-app.apk";
    const APP_WEB = "https://shgh-lms1.web.app/";
    const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
    const APP_ID_RE = /^[A-Za-z0-9]{10,40}$/;
    const now = () => admin.firestore.Timestamp.now();

    const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
    const paras = (text) => text.split("\n\n").map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
    const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "there";

    // Same text as welcomeEmail() in src/lib/recruitmentMail.ts, with the password link in it.
    function welcomeText(app, courseLine, passwordLink) {
        const password = passwordLink
            ? `Password: create your own password with this link: ${passwordLink}\nThe link works for a short time only. If it has expired, open the app, tap "Forgot Password?" on the login screen and enter your email to get a new one.`
            : "Password: you will receive a separate email with a link to create your own password. Please check your spam or junk folder if you cannot find it. If the link has expired, open the app, tap \"Forgot Password?\" on the login screen and enter your email to get a new one.";
        return `Dear ${firstName(app.name)},

Congratulations! We are delighted to welcome you to Sovereign House GH as ${app.role}.

${courseLine ? courseLine : "You will be assigned to a course soon, and we will let you know the details."}

Your login for our LMS App
Email: ${app.email}
${password}

Get started
Video tutorial: ${APP_VIDEO}
Android app: ${APP_APK}
Web app (iPhone, tablet or computer): ${APP_WEB}

To install on Android, open the app link on your phone, download the file and tap it to install. If your phone asks, allow installing apps from this source. The app keeps itself up to date.

We highly encourage you to read our official policies inside the app.

Best regards,
Sovereign House GH Team`;
    }
    const WELCOME_SUBJECT = "Welcome to Sovereign House GH: your volunteer place and app details";

    // Initials avatar, same format as createStaffAccount in index.js.
    function avatarUrl(name) {
        const words = String(name || "").trim().split(/\s+/).filter(Boolean)
            .map((w) => (w.match(/\p{L}/u) || [""])[0]).filter(Boolean);
        const t = words.length ? (words[0] + (words.length > 1 ? words[words.length - 1] : "")).toLocaleUpperCase("en-GB") : "?";
        return "https://placehold.co/100x100/22d3ee/0e7490?text=" + encodeURIComponent(t);
    }

    async function defaultManagerId() {
        try {
            const c = await db.collection("lineManagement").doc("settings").get();
            return c.exists ? String(c.data().defaultManagerId || "") : "";
        } catch (e) { return ""; }
    }

    function cleanList(list, max) {
        const out = [...new Set((Array.isArray(list) ? list : []).map((e) => String(e || "").trim().toLowerCase()).filter((e) => EMAIL_RE.test(e) && e.length <= 254))];
        return out.slice(0, max);
    }

    const acceptVolunteerApplication = onCall({ timeoutSeconds: 120 }, async (request) => {
        if (!request.auth) throw new HttpsError("unauthenticated", "You must be signed in.");
        const caller = await callerProfile(request.auth.uid);
        if (!(userCan(caller, "volunteer_applications") || userCan(caller, "volunteers") || userCan(caller, "app_admin"))) {
            throw new HttpsError("permission-denied", "You need the Volunteer Applications or Volunteers permission to accept a volunteer.");
        }
        const data = request.data || {};
        const applicationId = String(data.applicationId || "");
        if (!APP_ID_RE.test(applicationId)) throw new HttpsError("invalid-argument", "Unknown application.");
        const courseId = String(data.courseId || "").trim();
        if (courseId && !/^[A-Za-z0-9_-]{1,100}$/.test(courseId)) throw new HttpsError("invalid-argument", "Unknown course.");
        const rc = data.recipients || {};
        const to = cleanList(rc.to, 10);
        const cc = cleanList(rc.cc, 20).filter((e) => !to.includes(e));
        if (!to.length) throw new HttpsError("invalid-argument", "Tick at least one person to receive the welcome email.");
        const courseLineIn = typeof data.courseLine === "string" ? data.courseLine.trim().slice(0, 500) : "";

        const appRef = db.collection("volunteer_applications").doc(applicationId);

        // One Accept at a time for an application (a double click must not create two assignments).
        const LOCK_MS = 2 * 60 * 1000;
        const app = await db.runTransaction(async (tx) => {
            const s = await tx.get(appRef);
            if (!s.exists) throw new HttpsError("not-found", "Application not found. It may have been deleted.");
            const a = s.data();
            if (a.status === "declined") throw new HttpsError("failed-precondition", "This application was declined, so it cannot be accepted.");
            const lock = a.acceptRunning;
            if (lock && lock.at && typeof lock.at.toMillis === "function" && Date.now() - lock.at.toMillis() < LOCK_MS) {
                throw new HttpsError("aborted", "Someone is accepting this application right now. Wait a minute and try again.");
            }
            tx.update(appRef, { acceptRunning: { by: request.auth.uid, at: now() } });
            return a;
        });

        const email = String(app.email || "").trim().toLowerCase();
        const name = String(app.name || "").trim().slice(0, 120);
        const steps = { ...(app.acceptSteps || {}) };
        const ran = [];
        const record = async (key, value) => {
            steps[key] = { ...value, at: now(), by: request.auth.uid };
            await appRef.update({ [`acceptSteps.${key}`]: steps[key] });
            ran.push(key);
        };

        try {
            if (!name) throw new HttpsError("failed-precondition", "The application has no name.");
            if (!EMAIL_RE.test(email)) throw new HttpsError("failed-precondition", "The application has no valid email address, so no login can be made.");

            // 1. The login: create it, or reuse the one this email already has.
            let uid = steps.account && steps.account.uid ? String(steps.account.uid) : "";
            if (uid) {
                try { await admin.auth().getUser(uid); } catch (e) {
                    if (e.code === "auth/user-not-found") { uid = ""; delete steps.account; } else throw e;
                }
            }
            if (!uid) {
                let existing = null;
                try { existing = await admin.auth().getUserByEmail(email); } catch (e) {
                    if (e.code !== "auth/user-not-found") throw new HttpsError("internal", "Could not check existing logins.");
                }
                if (existing) {
                    const p = await db.collection("users").doc(existing.uid).get();
                    const role = p.exists ? String(p.data().role || "") : "";
                    const ours = p.exists && p.data().applicationId === applicationId;
                    if (p.exists && !["", "standard_user"].includes(role) && !(role === "volunteer" && ours)) {
                        throw new HttpsError("already-exists",
                            `${email} already has an account in the portal (role: ${role}). Nothing was changed. Ask a super admin to check that account.`);
                    }
                    await record("account", { uid: existing.uid, created: false, upgraded: p.exists && role !== "volunteer" });
                    uid = existing.uid;
                } else {
                    const legacy = await db.collection("users").where("email", "==", email).limit(3).get();
                    if (!legacy.empty) {
                        throw new HttpsError("failed-precondition",
                            `A profile for ${email} already exists but has no login (record ${legacy.docs.map((d) => d.id).join(", ")}). Ask Franco to repair it rather than adding the person twice.`);
                    }
                    let u;
                    try { u = await admin.auth().createUser({ email, displayName: name, emailVerified: false, disabled: false }); } catch (e) {
                        if (e.code === "auth/invalid-email") throw new HttpsError("invalid-argument", "Firebase rejected the applicant's email address.");
                        throw new HttpsError("internal", `The login could not be created (${e.code || e.message}).`);
                    }
                    uid = u.uid;
                    await record("account", { uid, created: true, upgraded: false });
                }
            }

            // 2. The profile.
            if (!steps.profile) {
                const userRef = db.collection("users").doc(uid);
                const cur = await userRef.get();
                const c = cur.exists ? cur.data() : {};
                if (cur.exists && !["", "standard_user", "volunteer"].includes(String(c.role || ""))) {
                    throw new HttpsError("already-exists", `${email} already has an account in the portal (role: ${c.role}). Nothing more was changed.`);
                }
                const mgr = c.managerId || await defaultManagerId();
                const profile = {
                    name, displayName: name, email, role: "volunteer",
                    phone: String(app.phone || ""), age: String(app.age || ""), gender: String(app.gender || ""),
                    volunteerRole: String(app.role || ""), availability: app.availability && typeof app.availability === "object" ? app.availability : {},
                    applicationId,
                    profilePicUrl: c.profilePicUrl || avatarUrl(name),
                    leaveAllowance: admin.firestore.FieldValue.delete(), // volunteers have no annual leave
                    updatedBy: request.auth.uid, updatedAt: now(), // for the change log
                };
                if (mgr) profile.managerId = mgr;
                if (!cur.exists) { profile.createdAt = now(); profile.createdBy = request.auth.uid; } else if (c.role !== "volunteer") { profile.upgradedBy = request.auth.uid; profile.upgradedAt = now(); }
                await userRef.set(profile, { merge: true });
                await record("profile", { uid, managerId: mgr || "" });
            }

            // 3. The course (only when one was chosen).
            let course = null;
            if (courseId) {
                const cs = await db.collection("course").doc(courseId).get();
                if (cs.exists) course = { id: cs.id, ...cs.data() };
            }
            if (courseId && !steps.course) {
                if (!course) throw new HttpsError("not-found", "The chosen course no longer exists. Choose another or none.");
                // Same document id and fields as the course page (courseId_uid, assignedAt ISO), so
                // the course page can remove it and a second run never adds a second one.
                const dup = await db.collection("courseAssignments").where("courseId", "==", courseId).where("volunteerId", "==", uid).limit(1).get();
                let assignmentId;
                if (!dup.empty) assignmentId = dup.docs[0].id;
                else {
                    assignmentId = `${courseId}_${uid}`;
                    await db.collection("courseAssignments").doc(assignmentId).set({ courseId, volunteerId: uid, assignedAt: new Date().toISOString() });
                }
                await record("course", { courseId, assignmentId });
            }

            // 4. The password link and the welcome email.
            if (!steps.welcome) {
                let link = "";
                try { link = await admin.auth().generatePasswordResetLink(email); } catch (e) { console.warn("acceptVolunteerApplication: no password link", e.code || e.message); }
                const assigned = course || (steps.course && steps.course.courseId ? await (async () => {
                    const s = await db.collection("course").doc(steps.course.courseId).get();
                    return s.exists ? { id: s.id, ...s.data() } : null;
                })() : null);
                const courseLine = courseLineIn || (assigned ? `You have been assigned to ${assigned.code ? assigned.code + " " : ""}${assigned.name || "a course"}. You will see its details, dates and students in the app.` : "");
                const text = welcomeText({ name, email, role: app.role || "a volunteer" }, courseLine, link);
                const mail = await db.collection("mail").add({
                    to, cc, subject: WELCOME_SUBJECT, text, html: paras(text), kind: "welcome", applicationId,
                    from: FROM, status: "queued", createdBy: request.auth.uid, createdAt: admin.firestore.FieldValue.serverTimestamp(),
                });
                await record("welcome", { mailId: mail.id, passwordLink: !!link });
            }

            // Done: the application is accepted.
            const finalCourse = (steps.course && steps.course.courseId) || "";
            await appRef.update({
                status: "accepted",
                decision: { by: request.auth.uid, at: new Date().toISOString(), outcome: "accepted", courseId: finalCourse, userId: uid },
                acceptRunning: admin.firestore.FieldValue.delete(),
            });
            console.log(`acceptVolunteerApplication: ${request.auth.uid} accepted ${applicationId} as ${uid}; ran ${ran.join(", ") || "nothing (all done before)"}`);
            const stepsOut = {};
            for (const k of ["account", "profile", "course", "welcome"]) {
                const s = steps[k];
                stepsOut[k] = s ? { done: true, ranNow: ran.includes(k), at: s.at && s.at.toDate ? s.at.toDate().toISOString() : "", ...(k === "account" ? { created: !!s.created, upgraded: !!s.upgraded } : {}) } : { done: false, ranNow: false };
            }
            return { uid, ran, steps: stepsOut };
        } catch (e) {
            try { await appRef.update({ acceptRunning: admin.firestore.FieldValue.delete() }); } catch (e2) { /* ignore */ }
            if (e instanceof HttpsError) {
                // Say which steps are already done, so the page can show them.
                throw new HttpsError(e.code, `${e.message}${ran.length ? ` (done now: ${ran.join(", ")})` : ""}`, { steps: Object.keys(steps) });
            }
            console.error("acceptVolunteerApplication", e);
            throw new HttpsError("internal", `The acceptance stopped: ${String(e.message || e).slice(0, 200)}. Press Accept again to carry on from where it stopped.`, { steps: Object.keys(steps) });
        }
    });

    // The CV of an accepted volunteer: users/{uid}.applicationId -> the application's CV.
    const getVolunteerCvForVolunteer = onCall(async (request) => {
        if (!request.auth) throw new HttpsError("unauthenticated", "You must be signed in.");
        const caller = await callerProfile(request.auth.uid);
        if (!(userCan(caller, "volunteers") || userCan(caller, "volunteer_applications"))) {
            throw new HttpsError("permission-denied", "You need the Volunteers permission to open a volunteer's CV.");
        }
        const uid = String((request.data && request.data.uid) || "");
        if (!/^[A-Za-z0-9]{1,128}$/.test(uid)) throw new HttpsError("invalid-argument", "Unknown volunteer.");
        const u = await db.collection("users").doc(uid).get();
        if (!u.exists) throw new HttpsError("not-found", "This volunteer could not be found.");
        const appId = String(u.data().applicationId || "");
        if (!APP_ID_RE.test(appId)) throw new HttpsError("not-found", "This volunteer did not apply through the online form, so there is no CV from an application.");
        const app = await db.collection("volunteer_applications").doc(appId).get();
        if (!app.exists) throw new HttpsError("not-found", "Their application has been deleted, so the CV is no longer kept.");
        if (!app.data().cvPath) throw new HttpsError("not-found", "Their application has no CV.");
        let buf;
        try { [buf] = await admin.storage().bucket().file(app.data().cvPath).download(); } catch (e) {
            if (e.code === 404) throw new HttpsError("not-found", "The CV file is no longer in storage.");
            throw e;
        }
        return { base64: buf.toString("base64"), name: app.data().cvName || "cv.pdf" };
    });

    // CVs left behind: older than 24 hours, and their application (the folder name) is gone.
    const cleanupOrphanCvs = onSchedule(
        { schedule: "every day 04:00", timeZone: "Europe/London", timeoutSeconds: 300 },
        async () => {
            const cutoff = Date.now() - 24 * 60 * 60 * 1000;
            const [files] = await admin.storage().bucket().getFiles({ prefix: "volunteerCVs/" });
            const known = new Map();
            let scanned = 0, tooNew = 0, kept = 0, deleted = 0, failed = 0, skipped = 0;
            for (const f of files) {
                scanned++;
                const parts = f.name.split("/");
                const appId = parts[1] || "";
                if (parts.length < 3 || !parts[2] || !APP_ID_RE.test(appId)) { skipped++; continue; }
                const created = Date.parse((f.metadata && (f.metadata.timeCreated || f.metadata.updated)) || "");
                if (!created || created > cutoff) { tooNew++; continue; }
                if (!known.has(appId)) known.set(appId, (await db.collection("volunteer_applications").doc(appId).get()).exists);
                if (known.get(appId)) { kept++; continue; }
                try { await f.delete(); deleted++; } catch (e) { failed++; console.warn("cleanupOrphanCvs: could not delete", f.name, e.message); }
            }
            console.log(`cleanupOrphanCvs: ${scanned} files, ${deleted} deleted, ${kept} kept (application exists), ${tooNew} newer than 24 hours, ${skipped} not a CV path, ${failed} failed`);
        });

    return { acceptVolunteerApplication, getVolunteerCvForVolunteer, cleanupOrphanCvs };
};
