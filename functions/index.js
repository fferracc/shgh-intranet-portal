const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { FUNDING_CONTEXT } = require("./fundingContext.js");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// ---------------------------------------------------------------------------
// PERMISSIONS ON THE SERVER (30 Sep 2026)
// The same model as src/lib/permissions.ts, so a feature a super admin switches off for
// someone (deniedPermissions) is switched off here too. Keep ROLE_DEFAULTS in step.
//   effective = super_admin ? everything
//             : permissions has it OR (role gives it AND deniedPermissions does not)
// ---------------------------------------------------------------------------
const ROLE_DEFAULTS = {
    admin: ["students", "courses", "class_reports", "calendar", "ghana_ops", "volunteers", "badges",
        "volunteer_applications", "student_applications", "announcements", "social_media", "grants",
        "inventory", "leave_manage", "app_admin", "statistics"],
    staff: ["students", "courses", "class_reports", "calendar", "inventory"],
    line_manager: ["inventory", "leave_manage"],
    standard_user: [],
    volunteer: ["class_reports", "calendar", "ghana_ops"],
};
function userCan(u, key) {
    if (!u) return false;
    if (u.archived === true) return false;
    if (u.role === "super_admin") return true;
    if (Array.isArray(u.permissions) && u.permissions.includes(key)) return true;
    const denied = Array.isArray(u.deniedPermissions) ? u.deniedPermissions : [];
    return (ROLE_DEFAULTS[u.role] || []).includes(key) && !denied.includes(key);
}
async function callerProfile(uid) {
    const snap = await db.collection("users").doc(uid).get();
    return snap.exists ? snap.data() : null;
}
async function callerCan(uid, key) {
    return userCan(await callerProfile(uid), key);
}

// Public forms can make the server email the address typed in (the applicant's copy).
// At most 3 copies per address per UK day, so nobody can use the forms to send
// mail from recruitment@ to any inbox (1 Oct 2026 review). Returns true if allowed.
async function allowApplicantCopy(email) {
    const crypto = require("crypto");
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
    const key = crypto.createHash("sha256").update(String(email).toLowerCase()).digest("hex").slice(0, 40) + "_" + day;
    const ref = db.collection("mailRate").doc(key);
    return db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        const n = s.exists ? Number(s.data().count) || 0 : 0;
        if (n >= 3) return false;
        tx.set(ref, { count: n + 1, day, at: admin.firestore.FieldValue.serverTimestamp() });
        return true;
    });
}

async function runAggregation() {
    console.log("Starting nightly aggregation of dashboard statistics...");

    // 1. Inventory Stats
    const invSnap = await db.collection("laptopInventory").get();
    const donSnap = await db.collection("donatedInventory").get();
    const wasSnap = await db.collection("wastedInventory").get();

    const countsLoc = {};
    const countsType = {};

    invSnap.forEach((doc) => {
        const data = doc.data();
        const loc = data.location || "Unknown";
        const type = data.type || "Laptop";
        countsLoc[loc] = (countsLoc[loc] || 0) + 1;
        countsType[type] = (countsType[type] || 0) + 1;
    });

    const locationStats = Object.entries(countsLoc)
        .map(([location, count]) => ({ location, count }))
        .sort((a, b) => b.count - a.count);

    const typeStats = Object.entries(countsType)
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count);

    const activityStats = [
        { activity: "Active Inventory", count: invSnap.size },
        { activity: "Donated", count: donSnap.size },
        { activity: "Wasted", count: wasSnap.size }
    ].sort((a, b) => b.count - a.count);

    // 2. Students (Age Split)
    const sSnap = await db.collection("students").get();
    let totalStudents = 0;
    let under18Sum = 0, under18Count = 0;
    let over18Sum = 0, over18Count = 0;

    sSnap.forEach((doc) => {
        totalStudents++;
        const d = doc.data();
        const age = Number(d.age);
        if (age) {
            if (age < 18) {
                under18Sum += age;
                under18Count++;
            } else {
                over18Sum += age;
                over18Count++;
            }
        }
    });

    // 3. Courses
    const cSnap = await db.collection("course").get();
    let activeRolling = 0;
    let activeDropIn = 0;
    let finished = 0;
    const courseDurations = {};
    const courseTypeMap = {};

    cSnap.forEach((doc) => {
        const data = doc.data();
        if (data.status === "Running") {
            if (data.type === "Drop-in") activeDropIn++;
            else activeRolling++;
        } else if (data.status === "Completed" || data.status === "Cancelled") {
            finished++;
        }
        if (data.duration) courseDurations[doc.id] = Number(data.duration);
        if (data.type) courseTypeMap[doc.id] = data.type;
    });

    // 4. Volunteers/Staff
    const vSnap = await db.collection("users").get();
    let admins = 0;
    const volunteersMap = {};

    vSnap.forEach((doc) => {
        const d = doc.data();
        if (["admin", "super_admin"].includes(d.role)) admins++;
        if (["volunteer", "staff", "admin", "super_admin"].includes(d.role) || d.role?.toLowerCase() === "volunteer") {
            volunteersMap[doc.id] = { name: d.displayName || d.name || d.firstName || "Unknown" };
        }
    });

    // 5. Attendance Calculation
    const attSnap = await db.collection("attendanceRecords").get();

    const volActivity = {};
    Object.keys(volunteersMap).forEach((uid) => {
        volActivity[uid] = { sessions: 0, sessionHours: 0, extraHours: 0 };
    });

    const activitiesSnap = await db.collection("volunteerActivities").where("status", "==", "approved").get();
    activitiesSnap.forEach((doc) => {
        const data = doc.data();
        if (data.volunteerId && volActivity[data.volunteerId]) {
            volActivity[data.volunteerId].extraHours += (Number(data.hours) || 0);
        }
    });

    const courseSessions = {};
    const coursePresent = {};

    attSnap.forEach((doc) => {
        const data = doc.data();

        if (!courseSessions[data.courseId]) {
            courseSessions[data.courseId] = new Set();
            coursePresent[data.courseId] = 0;
        }
        if (data.date) {
            courseSessions[data.courseId].add(data.date);
        }

        if (data.studentId) {
            coursePresent[data.courseId] = (coursePresent[data.courseId] || 0) + 1;
        }

        if (data.userId && volActivity[data.userId]) {
            const duration = courseDurations[data.courseId] || 1;
            volActivity[data.userId].sessions++;
            volActivity[data.userId].sessionHours += duration;
        }
    });

    const volList = Object.entries(volActivity)
        .map(([id, stats]) => {
            const total = stats.sessionHours + stats.extraHours;
            return {
                id,
                name: volunteersMap[id].name,
                sessions: stats.sessions,
                hours: Math.round(total * 10) / 10
            };
        })
        .filter((v) => v.hours > 0)
        .sort((a, b) => b.hours - a.hours);

    const rosterSnap = await db.collection("courseRoster").get();
    const courseStudentCounts = {};
    const enrolledStudentIds = new Set();

    rosterSnap.forEach((doc) => {
        const data = doc.data();
        if (data.role === "student" || data.studentId) {
            courseStudentCounts[data.courseId] = (courseStudentCounts[data.courseId] || 0) + 1;
            if (data.studentId) enrolledStudentIds.add(data.studentId);
        }
    });

    let sumRates = 0;
    let count = 0;

    cSnap.forEach((doc) => {
        const courseId = doc.id;
        const studentCount = courseStudentCounts[courseId] || 0;
        const sessionsHeld = courseSessions[courseId]?.size || 0;
        const presentCount = coursePresent[courseId] || 0;

        if (sessionsHeld > 0 && courseTypeMap[courseId] !== "Drop-in") {
            const totalExpected = sessionsHeld * studentCount;
            const rate = totalExpected > 0 ? Math.min(100, (presentCount / totalExpected) * 100) : 0;
            sumRates += rate;
            count++;
        }
    });

    const studentAttendanceRate = count > 0 ? Math.round(sumRates / count) : 0;
    const studentUnrecorded = Math.max(0, 100 - studentAttendanceRate);

    const platformStatsObj = {
        students: {
            total: totalStudents,
            enrolled: enrolledStudentIds.size,
            under18Avg: under18Count > 0 ? Math.round(under18Sum / under18Count) : 0,
            over18Avg: over18Count > 0 ? Math.round(over18Sum / over18Count) : 0
        },
        courses: { total: cSnap.size, activeRolling, activeDropIn, finished },
        volunteers: { totalUsers: vSnap.size, activeVolunteers: volList.length, admins, list: volList },
        inventory: { total: invSnap.size },
        attendance: {
            rate: studentAttendanceRate > 100 ? 100 : studentAttendanceRate,
            data: [
                { name: "Present", value: studentAttendanceRate > 100 ? 100 : studentAttendanceRate },
                { name: "Absent", value: studentUnrecorded > 100 ? 0 : studentUnrecorded },
            ]
        }
    };

    const finalData = {
        locationStats,
        typeStats,
        activityStats,
        platformStats: platformStatsObj,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    };

    // Write to Firestore
    await db.collection("statistics").doc("platformStats").set(finalData);

    console.log("Nightly aggregation completed and saved to statistics/platformStats.");
    return null;
}

// REMOVED 30 Sep 2026: exports.aggregateDashboardStats (nightly). Nothing read
// statistics/platformStats and it used an old formula; every page now counts with
// src/lib/stats.ts. runAggregation() is kept below only for reference.

// REMOVED 2026-09-23: exports.triggerDashboardAggregation
//
// It was an onRequest endpoint with no authentication. Anyone who knew the URL
// could run runAggregation(), which reads laptopInventory, donatedInventory,
// wastedInventory and students in full — on a Blaze (pay-as-you-go) project.
// Nothing in the portal ever called it; it was a testing shortcut.
// The scheduled aggregateDashboardStats above does the same job every 24 hours.
//
// If a manual re-run is ever needed, add it back as an onCall guarded by
// `if (!request.auth) throw new HttpsError('unauthenticated', ...)`, never onRequest.

// AI Grants Module
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

async function generateWithRetry(model, prompt, maxRetries = 3, initialDelay = 1500) {
    let delay = initialDelay;
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await model.generateContent(prompt);
        } catch (error) {
            if (error.status === 503 && i < maxRetries - 1) {
                console.warn(`[AI-Grants] 503 Service Unavailable. Retrying in ${delay}ms... (Attempt ${i + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 1.5; // Exponential backoff
            } else {
                throw error;
            }
        }
    }
}

exports.aiGrants = onCall(async (request) => {
    if (!genAI) {
        throw new HttpsError('internal', 'GEMINI_API_KEY is not configured in the Firebase Environment.');
    }

    try {
        const { action, payload } = request.data;

        // Enforced 2026-09-23. This is NOT optional: without it anyone can call
        // this function and spend the Gemini API key. Only signed-in users ever
        // reach the Grants page, so this breaks nothing.
        if (!request.auth) {
            throw new HttpsError('unauthenticated', 'You must be signed in to use the grants assistant.');
        }
        // 30 Sep 2026: every call costs money, so only people with Grants and Funding may use it
        // (it used to be any signed-in account, volunteers in the app included).
        // The Statistics page summary (1 Oct 2026) needs Statistics; everything else needs Grants.
        if (action === 'summarize_stats') {
            if (!(await callerCan(request.auth.uid, 'statistics'))) {
                throw new HttpsError('permission-denied', 'The statistics summary needs the Statistics permission.');
            }
            const prompt = String((payload && payload.prompt) || '');
            if (!prompt.trim()) throw new HttpsError('invalid-argument', 'There are no figures to summarise. Tick some first.');
            if (prompt.length > 30000) throw new HttpsError('invalid-argument', 'Too many figures ticked for one summary. Tick fewer sections.');
            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
            const result = await generateWithRetry(model, prompt);
            return { result: result.response.text() };
        }
        if (!(await callerCan(request.auth.uid, 'grants'))) {
            throw new HttpsError('permission-denied', 'The grants assistant needs the Grants and Funding permission.');
        }

        if (action === 'suggest_idea') {
            const { funderRequirements } = payload;
            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
            const prompt = `
            You are an expert grant writer for Sovereign House GH, a charity based in the UK operating programs in Bury and Ghana.
            
            Here is the core background and context of Sovereign House GH:
            ${FUNDING_CONTEXT}
            
            A user wants to apply for a grant with the following requirements / aims from the funder:
                "${funderRequirements}"
            
            Based strictly on Sovereign House GH's actual activities, history, and goals, suggest ONE highly compelling project idea that perfectly aligns with this funder's aims. 
            Do NOT makeup activities we haven't done or aren't planning to do (e.g.don't suggest building a hospital if we only do computer training). 
            Keep the suggestion to 1 - 2 paragraphs.Be persuasive.
            `;

            const result = await generateWithRetry(model, prompt);
            return { result: result.response.text() };
        }

        if (action === 'generate_draft') {
            const { funderRequirements, applicationForm, acceptedIdea, amount } = payload;
            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
            const prompt = `
            You are an expert grant writer for Sovereign House GH.

                    Context:
            ${FUNDING_CONTEXT}
            
            Funder Requirements:
            ${funderRequirements}
            
            The Approved Project Idea to pitch:
            ${acceptedIdea}
            
            Total Funding Requested: £${amount}
            
            Please complete the following Application Form, ensuring you strictly follow any word or character limits mentioned in the questions.
            Application Form:
            ${applicationForm}
            
            CRITICAL INSTRUCTION: At the very end of the application, you MUST include a well - structured Budget Table. 
            The total of this budget table MUST exactly equal £${amount}. Break down the costs logically based on the Approved Project Idea.Provide clear explanations for each calculation.
            Format the response clearly using Markdown.
                `;

            const result = await generateWithRetry(model, prompt);
            return { result: result.response.text() };
        }

        if (action === 'summarize') {
            const { funderText } = payload;
            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

            const prompt = `
            You are a grant researcher for Sovereign House GH. 
            Our Context:
            ${FUNDING_CONTEXT}
            
            Please analyze the following funder text / guidelines:
            ${funderText}
            
            Extract and output exactly these points in Markdown format:
                1. ** Funder Name:** (Extract the name of the foundation / grantor / funder)
                2. ** Funding Amount Available:** (What is the max / range they give ?)
                3. ** Deadline:** (When is the application due ?)
                4. ** Core Requirements:** (Bullet points of what they fund)
                5. ** Eligibility Check:** (Are we theoretically eligible based strictly on our context ? Say YES or NO and give a 1 sentence reason why).
                `;

            const result = await generateWithRetry(model, prompt);
            return { result: result.response.text() };
        }

        if (action === 'review') {
            const { draft, rubric } = payload;
            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

            const prompt = `
            You are a strict, objective, and highly experienced grant panel judge evaluating an application for Sovereign House GH.
            
            Here is the scoring rubric or criteria you must judge against:
            ${rubric}
            
            Here is the draft application:
            ${draft}
            
            Please provide a rigorous critique.Point out exactly where the application fails to meet the rubric, where it is weak, and suggest specific ways to improve it.Be constructive but very strict.
            `;

            const result = await generateWithRetry(model, prompt);
            return { result: result.response.text() };
        }

        if (action === 'generate_milestones') {
            const { fundingContent, grantName, amount } = payload;
            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

            const today = new Date().toISOString().split('T')[0];
            const prompt = `
            You are a project management expert for Sovereign House GH, a UK charity.

            A funding grant has been AWARDED.Here are the details:
            Grant Name: ${grantName || 'Unknown'}
                Amount: £${amount || 'Unknown'}
            
            Here is the full content / requirements of the awarded funding:
            ${fundingContent}

            Today's date is ${today}.

            Based on this funding, generate a complete project execution plan with milestones and tasks.
            
            Return ONLY a valid JSON array(no markdown, no code fences) with this structure:
                [
                    {
                        "milestone": "Milestone name",
                        "date": "YYYY-MM-DD",
                        "tasks": ["Task 1", "Task 2", "Task 3"],
                        "completed": false
                    }
                ]

            Include milestones for:
                    - Project setup and planning
                        - Key deliverables and activities required by the funder
                            - Monitoring and evaluation points
                                - Financial reporting deadlines
                                    - Interim reports
                                        - Final report and project closure
            
            Spread milestones across the project timeline realistically.Include 5 - 10 milestones with 2 - 5 tasks each.
            Return ONLY the JSON array, nothing else.
                `;

            const result = await generateWithRetry(model, prompt);
            const text = result.response.text().trim();

            let cleanJson = text;
            if (cleanJson.startsWith('```')) {
                cleanJson = cleanJson.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
            }

            try {
                const parsed = JSON.parse(cleanJson);
                return { result: parsed };
            } catch (e) {
                return { result: text };
            }
        }

        throw new HttpsError('invalid-argument', 'Invalid action');

    } catch (error) {
        if (error instanceof HttpsError) throw error;
        console.error("AI Grants Error in Cloud Function:", error);
        throw new HttpsError('internal', error.message || 'Error processing AI request');
    }
});

// --- Social Media Studio ---------------------------------------------------
// Generates per-network drafts from a guided brief. Runs server-side so the
// Gemini key never reaches the browser (the portal is a static export and
// cannot hold a secret).

const SHGH_BRAND = `
Sovereign House GH is a Greater Manchester charity working in the UK and Ghana.
In the UK it runs a Computer Learning Programme for children and adults facing
digital poverty, with centres in Bury and Salford, classes for over-50s, online
classes for children, robotics and life skills. In Ghana it supports orphans and
disadvantaged children through educational sponsorship, healthcare, social
housing and an international school.

VOICE:
- Warm, plain and specific. UK English: programme, organisation, realise.
- Concrete over abstract. "Our Bury centre runs beginner classes for over-50s on
  Tuesdays" beats "we deliver digital inclusion interventions".
- Dignity, never pity. The people are learners and participants, not cases or
  the needy. Never "underprivileged" or "the less fortunate". Never position the
  reader as rescuer.
- Short sentences, one idea each.
- Quiet confidence. They have won Heart of Salford awards and Football For
  Change funding. State such things plainly and move on.

NEVER:
- Stacked exclamation marks, or "we are thrilled to announce".
- Emoji unless explicitly asked for.
- Walls of hashtags.
- The word "empower" more than once in a post.
- Invented facts. No made-up learner numbers, funding figures, dates, quotes or
  outcomes. If a number is not supplied, write around it rather than guessing.
- Anything that identifies a child or implies a learner's personal
  circumstances.
`;

const NETWORK_GUIDANCE = {
    facebook: `Facebook. Room to breathe: 2-4 short paragraphs. Links are fine and
render a preview. Audience skews older and local, including parents and referrers.`,
    instagram: `Instagram. Caption up to 2,200 characters but only the first ~125
show before "more", so put the point in the first line. A handful of relevant
hashtags at the very end, not a wall. Links do not work in captions — if a link
is needed, say "link in bio".`,
    threads: `Threads. Under 500 characters. Conversational, a single clear
thought. No hashtag stacks.`,
    linkedin: `LinkedIn. Slightly more formal — the audience is funders, partners
and referrers. Truncates around 200 characters so front-load the substance.
Posts with external links get demoted, so refer to the link rather than pasting
it. Impact and partnership framing lands better than recruitment framing.`,
    youtube: `YouTube video description. First two lines matter most. Include a
short summary then practical detail. Links are fine.`,
    tiktok: `TikTok caption. Short, direct, energetic but not gimmicky. A couple
of hashtags maximum.`,
};

// The annual plan, loaded fresh on every generation. A plan you run once gets
// ignored by February; context that shapes every post keeps working. Failure
// here is deliberately soft — if the plan cannot be read, drafting carries on
// without it rather than blocking the studio.
async function loadPlanContext() {
    try {
        // This year's plan (UK year), not the plan with the highest year (1 Oct 2026).
        const year = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric' }).format(new Date());
        const snap = await db.collection('socialStrategy').doc(String(year)).get();
        if (!snap.exists) return '';
        const p = snap.data() || {};

        const lines = [];
        if (p.purpose) lines.push(`Why this organisation posts at all: ${p.purpose}`);

        if (Array.isArray(p.audiences) && p.audiences.length) {
            const ranked = p.audiences
                .filter((a) => a && a.name)
                .map((a, i) => `  ${i + 1}. ${a.name}${a.notes ? ` — ${a.notes}` : ''}`)
                .join('\n');
            if (ranked) {
                lines.push(`Audiences, most important first. Write for the ones near the top:\n${ranked}`);
            }
        }

        if (Array.isArray(p.successMeasures) && p.successMeasures.filter(Boolean).length) {
            lines.push(`What counts as success: ${p.successMeasures.filter(Boolean).join('; ')}`);
        }

        // The current quarter's priority and any seasonal anchor for this month
        // or the next, so autumn copy does not read like a spring post.
        const now = new Date();
        const q = 'q' + (Math.floor(now.getMonth() / 3) + 1);
        if (p.quarterFocus && p.quarterFocus[q]) {
            lines.push(`This quarter's priority: ${p.quarterFocus[q]}`);
        }

        if (Array.isArray(p.anchors) && p.anchors.length) {
            const thisMonth = now.toISOString().slice(0, 7);
            const nextDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
            const nextMonth = nextDate.toISOString().slice(0, 7);
            const near = p.anchors
                .filter((a) => a && a.date && (String(a.date).startsWith(thisMonth) || String(a.date).startsWith(nextMonth)))
                .map((a) => `  - ${a.date}: ${a.label}`)
                .join('\n');
            if (near) lines.push(`Where we are in the year right now:\n${near}`);
        }

        if (Array.isArray(p.themes) && p.themes.length) {
            const themes = p.themes
                .filter((t) => t && t.name)
                .map((t) => `  - ${t.name} (${t.sharePercent ?? 0}% of output)`)
                .join('\n');
            if (themes) lines.push(`The usual mix of themes:\n${themes}`);
        }

        let block = lines.length ? `\nTHE ANNUAL PLAN — written by the charity, treat it as the brief behind the brief:\n${lines.join('\n\n')}\n` : '';

        // Exclusions are appended last and phrased as absolutes, because they
        // are the safeguarding rules reaching the drafting stage.
        const never = Array.isArray(p.neverPost) ? p.neverPost.filter(Boolean) : [];
        if (never.length) {
            block += `\nHARD EXCLUSIONS set by the charity. These are not style preferences. Do not write anything that breaches them, even if the brief seems to ask for it:\n${never.map((n) => `- ${n}`).join('\n')}\n`;
        }

        return block;
    } catch (error) {
        console.error('loadPlanContext failed, generating without the plan:', error);
        return '';
    }
}

// The last handful of posts, so successive drafts stop reaching for the same
// three phrases — the real weakness of generating each post in isolation.
async function loadRecentCopy() {
    try {
        const snap = await db.collection('socialPosts')
            .orderBy('createdAt', 'desc')
            .limit(8)
            .get();
        const recent = snap.docs
            .map((d) => (d.data() || {}).copy)
            .filter((c) => typeof c === 'string' && c.trim())
            .map((c) => `  - ${c.replace(/\s+/g, ' ').slice(0, 160)}`);
        if (!recent.length) return '';
        return `\nRECENTLY POSTED — do not reuse these openings, phrases or framings:\n${recent.join('\n')}\n`;
    } catch (error) {
        console.error('loadRecentCopy failed, continuing without it:', error);
        return '';
    }
}

exports.socialDrafts = onCall(async (request) => {
    if (!genAI) {
        throw new HttpsError('internal', 'GEMINI_API_KEY is not configured in the Firebase Environment.');
    }
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'You must be signed in.');
    }

    // Social content is admin-only, matching the Firestore rules. Checked here
    // too because a callable function is reachable by any signed-in user.
    // 30 Sep 2026: the Social Media permission decides, as it does in the portal and the rules
    // (staff given Social Media were refused; an admin with it switched off was let through).
    if (!(await callerCan(request.auth.uid, 'social_media'))) {
        throw new HttpsError('permission-denied', 'The social media assistant needs the Social Media permission.');
    }

    const {
        whatHappened,
        audience,
        action,
        tone,
        networks,
        extraNotes,
        hasImage,
    } = request.data || {};

    if (!whatHappened || !String(whatHappened).trim()) {
        throw new HttpsError('invalid-argument', 'Tell the assistant what happened first.');
    }
    const nets = Array.isArray(networks) && networks.length ? networks : ['facebook'];

    const planContext = await loadPlanContext();
    const recentCopy = await loadRecentCopy();

    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const perNetwork = nets
        .map((n) => `- ${n}: ${NETWORK_GUIDANCE[n] || 'Write appropriately for this platform.'}`)
        .join('\n');

    const prompt = `
You write social media posts for Sovereign House GH.

${SHGH_BRAND}
${planContext}${recentCopy}
THE BRIEF:
What happened / what we want to say: ${whatHappened}
Who it is aimed at: ${audience || 'not specified — write for a general local audience'}
What we want them to do: ${action || 'no specific call to action'}
Tone: ${tone || 'warm and straightforward'}
${extraNotes ? `Extra notes: ${extraNotes}` : ''}
${hasImage ? 'An image will accompany the post, so do not describe the image in words.' : 'There is no image, so the words carry the whole post.'}

Write ONE post for each of these networks, tailored to each. Do not reuse the
same wording across networks — a reader who follows two of them should not see
the same sentences twice.

${perNetwork}

Return ONLY valid JSON, no markdown fence, in exactly this shape:
{"drafts":[{"network":"facebook","copy":"..."}]}
`;

    try {
        const result = await generateWithRetry(model, prompt);
        let text = result.response.text().trim();
        if (text.startsWith('```')) {
            text = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
        }
        const parsed = JSON.parse(text);
        if (!parsed.drafts || !Array.isArray(parsed.drafts)) {
            throw new Error('Model did not return a drafts array.');
        }
        return { drafts: parsed.drafts };
    } catch (error) {
        console.error('socialDrafts error:', error);
        throw new HttpsError('internal', error.message || 'Could not generate drafts.');
    }
});

// ---------------------------------------------------------------------------
// createStaffAccount — added 2026-09-24
//
// Creates a person's sign-in (Firebase Auth) AND their users/{uid} profile in
// one server-side step, so the UK app can add a teacher without anyone touching
// the Firebase Console.
//
// Why a Cloud Function and not the Ghana app's in-browser approach:
//  - Public sign-up is DISABLED on shgh-lms1 (turned off 7 Aug 2026 to close a
//    privilege-escalation hole). createUserWithEmailAndPassword from a browser
//    is therefore refused. The Admin SDK is not affected by that setting.
//  - The profile id is guaranteed to equal the Auth uid. The old UK app code
//    used addDoc(), which gave the profile a RANDOM id, so the person's login
//    never matched their profile and they could not sign in.
//  - Permission is checked here, on the server, so it cannot be bypassed.
//
// Who may create whom:
//   role 'volunteer' (a teacher)  <- admin, super_admin, or anyone granted the
//                                     'app_admin' or 'volunteers' permission
//   role 'admin'                  <- super_admin only
//
// No password is ever set or seen. The app sends the new person a Firebase
// "set your password" email straight after this returns.
// ---------------------------------------------------------------------------

const STAFF_EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

// Initials avatar, in the exact format every existing profile already uses:
//   https://placehold.co/100x100/22d3ee/0e7490?text=XX
// Rule: first letter of the first name + first letter of the last name.
// "Aji Haddy Njie" -> AN, "Kevin Maher" -> KM, a single name -> its first letter.
function staffInitials(name) {
    const words = String(name || "").trim().split(/\s+/).filter(Boolean)
        .map(w => (w.match(/\p{L}/u) || [""])[0]).filter(Boolean);
    if (!words.length) return "?";
    const first = words[0];
    const last = words.length > 1 ? words[words.length - 1] : "";
    return (first + last).toLocaleUpperCase("en-GB");
}
function staffAvatarUrl(name) {
    return "https://placehold.co/100x100/22d3ee/0e7490?text=" + encodeURIComponent(staffInitials(name));
}

// Volunteers have no annual leave (decided 24 Sep 2026), so they get no allowance field.
// The default line manager for new people (System > Line Managers, 29 Sep 2026).
async function defaultManagerId() {
    try {
        const c = await db.collection("lineManagement").doc("settings").get();
        return c.exists ? String(c.data().defaultManagerId || "") : "";
    } catch (e) { return ""; }
}

function staffProfile(name, email, role, createdBy, managerId) {
    const profile = {
        name,
        displayName: name,
        email,
        role,
        profilePicUrl: staffAvatarUrl(name),
        createdAt: admin.firestore.Timestamp.now(),
        createdBy,
        updatedBy: createdBy, updatedAt: admin.firestore.Timestamp.now(), // for the change log
    };
    if (managerId) profile.managerId = managerId;
    if (role !== "volunteer") {
        // Leave year starts 1 May (30 Sep 2026): entitlement 20 for full time; change it in Allowances.
        const now = new Date();
        const leaveYear = now.getMonth() >= 4 ? now.getFullYear() : now.getFullYear() - 1;
        profile.leaveAllowance = { entitlement: 20, total: 20, remaining: 20, year: leaveYear };
    }
    return profile;
}

exports.createStaffAccount = onCall(async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be signed in.");
    }

    // --- who is asking, and what are they allowed to do ---
    const callerSnap = await db.collection("users").doc(request.auth.uid).get();
    if (!callerSnap.exists) {
        throw new HttpsError("permission-denied", "Your own profile could not be found.");
    }
    const caller = callerSnap.data();
    const callerRole = caller.role || "";
    const isSuper = callerRole === "super_admin";
    // 30 Sep 2026: honours switched-off permissions. Volunteer Applications is enough to accept
    // an applicant (Accept used to fail for someone who only had that permission).
    const canManageTeachers = userCan(caller, "app_admin") || userCan(caller, "volunteers") || userCan(caller, "volunteer_applications");

    // --- validate the input ---
    const data = request.data || {};
    const name = String(data.name || "").trim();
    const email = String(data.email || "").trim().toLowerCase();
    const role = String(data.role || "volunteer");

    if (!name) throw new HttpsError("invalid-argument", "A name is required.");
    if (name.length > 120) throw new HttpsError("invalid-argument", "That name is too long.");
    if (!email || email.length > 254 || !STAFF_EMAIL_RE.test(email)) {
        throw new HttpsError("invalid-argument",
            "That is not a valid email address. A phone number will not work: people sign in with an email.");
    }
    if (role !== "volunteer" && role !== "admin") {
        throw new HttpsError("invalid-argument", "Only teachers (volunteers) or admins can be created here.");
    }
    if (role === "admin" && !isSuper) {
        throw new HttpsError("permission-denied", "Only a super admin can create an admin.");
    }
    if (role === "volunteer" && !canManageTeachers) {
        throw new HttpsError("permission-denied", "You do not have permission to add teachers.");
    }

    // --- refuse duplicates rather than guess ---
    // A profile with this email but a random id is a leftover from the old
    // addDoc() bug. Do not create a second record on top of it; report it.
    const byEmail = await db.collection("users").where("email", "==", email).limit(5).get();

    let existingAuth = null;
    try {
        existingAuth = await admin.auth().getUserByEmail(email);
    } catch (e) {
        if (e.code !== "auth/user-not-found") throw new HttpsError("internal", "Could not check existing logins.");
    }

    if (existingAuth) {
        const linked = byEmail.docs.find(d => d.id === existingAuth.uid);
        // 29 Sep 2026: an account with no access yet (someone who signed up on their
        // own) becomes the volunteer being accepted, keeping their login.
        if (linked && role === "volunteer" && ["", "standard_user"].includes(String(linked.data().role || ""))) {
            const mgr = linked.data().managerId || await defaultManagerId();
            await linked.ref.set({ role: "volunteer", name, displayName: name, profilePicUrl: linked.data().profilePicUrl || staffAvatarUrl(name),
                upgradedBy: request.auth.uid, upgradedAt: admin.firestore.Timestamp.now(),
                updatedBy: request.auth.uid, updatedAt: admin.firestore.Timestamp.now(),
                ...(mgr ? { managerId: mgr } : {}),
                leaveAllowance: admin.firestore.FieldValue.delete() }, { merge: true }); // volunteers have no leave
            console.log(`createStaffAccount: ${request.auth.uid} upgraded ${existingAuth.uid} <${email}> from no access to volunteer`);
            return { uid: existingAuth.uid, created: false, upgradedExisting: true };
        }
        if (linked) {
            throw new HttpsError("already-exists",
                `${email} already has a login and a profile (role: ${linked.data().role || "none"}). Nothing was changed.`);
        }
        // Login exists but has no profile under its uid: attach one. This repairs
        // the six orphan accounts found in the August audit if they are re-added.
        await db.collection("users").doc(existingAuth.uid).set(staffProfile(name, email, role, request.auth.uid, await defaultManagerId()));
        return { uid: existingAuth.uid, created: false, linkedExistingLogin: true, legacyProfiles: byEmail.size };
    }

    if (!byEmail.empty) {
        const ids = byEmail.docs.map(d => d.id).join(", ");
        throw new HttpsError("failed-precondition",
            `A profile for ${email} already exists but has no login (record ${ids}). ` +
            "It was created the old way and cannot sign in. Ask Franco to repair it rather than adding the person twice.");
    }

    // --- create the login, then the profile; undo the login if the profile fails ---
    let userRecord;
    try {
        userRecord = await admin.auth().createUser({ email, displayName: name, emailVerified: false, disabled: false });
    } catch (e) {
        if (e.code === "auth/email-already-exists") {
            throw new HttpsError("already-exists", `${email} already has a login.`);
        }
        if (e.code === "auth/invalid-email") {
            throw new HttpsError("invalid-argument", "Firebase rejected that email address.");
        }
        console.error("createStaffAccount: createUser failed", e);
        throw new HttpsError("internal", "The login could not be created.");
    }

    try {
        await db.collection("users").doc(userRecord.uid).set(staffProfile(name, email, role, request.auth.uid, await defaultManagerId()));
    } catch (e) {
        console.error("createStaffAccount: profile write failed, rolling back login", e);
        try { await admin.auth().deleteUser(userRecord.uid); } catch (e2) { console.error("rollback failed", e2); }
        throw new HttpsError("internal", "The profile could not be saved, so the login was removed again. Nothing was created.");
    }

    console.log(`createStaffAccount: ${request.auth.uid} created ${role} ${userRecord.uid} <${email}>`);
    return { uid: userRecord.uid, created: true, linkedExistingLogin: false };
});

// ---------------------------------------------------------------------------
// BADGES (24 Sep 2026, rebuilt 30 Sep 2026 with Franco's decisions)
// The server is the only place that awards badges automatically. The portal and the UK app
// only show them (and ask the server to award one by hand). The same rules are written out
// in Intranet Portal/src/lib/badges.ts and in the UK app (badge helpers): keep all three in step.
//
// Badge types (achievementsBadges.type) with a target (goal):
//   classCount       classes taught: distinct (course, date) teacher ticks in the registers
//                    of courses that still exist, plus every 1-2-1 session
//   hours            hours volunteered: each of those classes = the course's timetable length,
//                    plus 1-2-1 minutes / 60, plus approved "Log Hours" requests
//   monthsOfService  whole months from the person's first class, 1-2-1 session or approved
//                    activity to today
//   coursesTaught    distinct courses with at least one teacher tick or 1-2-1 session
//   anything else ("Manual" or no type) is awarded by hand only.
// These are the rules of src/lib/stats.ts (volunteer hours, classes taught), so the numbers on
// a profile and the badge progress always agree.
//
// Retroactive with the real date: the person's dated events are walked in order and earnedAt
// is the day the target was actually reached (reachedOn 'YYYY-MM-DD'; today when no date can
// be found). value = the figure on that day.
// An earned badge is NEVER changed or deleted by the server: create() only, one fixed id per
// person and badge ({uid}_{badgeId}), and a badge the person already has (under any id) is
// skipped. Archived badges are no longer awarded; archived people are still checked
// (their history counts).
// Hand awards (manual: true, awardedBy = uid, awardedByName, reason) go through
// awardBadgeByHand; only a super admin can withdraw one (withdrawHandBadge), and a copy is
// kept in badgeWithdrawals.
// ---------------------------------------------------------------------------
const { onDocumentCreated, onDocumentUpdated, onDocumentWritten } = require("firebase-functions/v2/firestore");

const BADGE_AUTO_TYPES = ["classCount", "hours", "monthsOfService", "coursesTaught"];

function scheduleHours(course) {
    const s = course && course.schedule;
    if (!s || !s.start || !s.end) return 0;
    const [sh, sm] = String(s.start).split(":").map(Number);
    const [eh, em] = String(s.end).split(":").map(Number);
    const d = (eh + (em || 0) / 60) - (sh + (sm || 0) / 60);
    return d > 0 ? d : 0;
}

// Firestore Timestamp, Date or string -> 'YYYY-MM-DD' (the portal's toDay).
function badgeDay(v) {
    if (!v) return "";
    if (typeof v === "string") return v.slice(0, 10);
    if (typeof v.toDate === "function") return v.toDate().toISOString().slice(0, 10);
    if (v instanceof Date) return isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
    if (typeof v.seconds === "number") return new Date(v.seconds * 1000).toISOString().slice(0, 10);
    if (typeof v._seconds === "number") return new Date(v._seconds * 1000).toISOString().slice(0, 10);
    return "";
}
function badgeValidDay(d) { return /^\d{4}-\d{2}-\d{2}$/.test(String(d || "")); }
function londonDay(d = new Date()) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(d);
}
// 'YYYY-MM-DD' + n months; the day is kept, or the last day of a shorter month (31 Jan + 1 = 28 Feb).
function addMonthsDay(day, n) {
    const [y, m, d] = String(day).split("-").map(Number);
    const total = (m - 1) + n;
    const ny = y + Math.floor(total / 12);
    const nm = ((total % 12) + 12) % 12;
    const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
    return `${ny}-${String(nm + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}
// Whole months from `from` to `to`: the largest n with from + n months <= to.
function wholeMonthsBetween(from, to) {
    if (!badgeValidDay(from) || !badgeValidDay(to) || to < from) return 0;
    const [fy, fm] = from.split("-").map(Number);
    const [ty, tm] = to.split("-").map(Number);
    let n = (ty - fy) * 12 + (tm - fm);
    while (n > 0 && addMonthsDay(from, n) > to) n--;
    return Math.max(0, n);
}
const round1 = (x) => Math.round((Number(x) || 0) * 10) / 10;

// One person's dated events, oldest first (undated ones last).
//   { day, classes (0 or 1), hours, courseId }
function badgeEvents(uid, rows, courseById) {
    const events = [];
    const seen = new Set();
    (rows.attendance || []).forEach((a) => {
        if (!a || a.userId !== uid || !a.courseId || !a.date || !courseById.has(a.courseId)) return;
        const key = `${a.courseId}|${a.date}`;   // a register saved twice on one day counts once
        if (seen.has(key)) return;
        seen.add(key);
        events.push({ day: String(a.date).slice(0, 10), classes: 1, hours: scheduleHours(courseById.get(a.courseId)), courseId: a.courseId });
    });
    (rows.oneToOne || []).forEach((o) => {
        if (!o || o.volunteerId !== uid) return;
        events.push({ day: badgeDay(o.date), classes: 1, hours: (Number(o.durationMinutes) || 0) / 60, courseId: o.courseId || "" });
    });
    (rows.activities || []).forEach((a) => {
        if (!a || a.volunteerId !== uid || a.status !== "approved") return;
        events.push({ day: badgeDay(a.date) || badgeDay(a.createdAt), classes: 0, hours: Number(a.hours) || 0, courseId: "" });
    });
    events.forEach((e) => { if (!badgeValidDay(e.day)) e.day = ""; });
    events.sort((x, y) => (x.day === y.day ? 0 : !x.day ? 1 : !y.day ? -1 : x.day < y.day ? -1 : 1));
    return events;
}

// Where a person stands on one automatic badge. null for a badge awarded by hand only.
function badgeCheck(badge, events, today) {
    const type = badge && badge.type;
    const goal = Number(badge && badge.goal) || 0;
    if (!BADGE_AUTO_TYPES.includes(type) || goal <= 0) return null;
    const clamp = (d) => (!d || d > today ? today : d);
    if (type === "monthsOfService") {
        const first = events.find((e) => e.day);
        const start = first ? first.day : "";
        const current = start ? wholeMonthsBetween(start, today) : 0;
        const reached = current >= goal;
        return { type, goal, current, reached, reachedOn: reached ? clamp(addMonthsDay(start, goal)) : "", value: reached ? goal : current };
    }
    let current = 0;
    let reachedOn = "";
    let value = 0;
    const courses = new Set();
    for (const e of events) {
        if (type === "classCount") current += e.classes;
        else if (type === "hours") current += e.hours;
        else {
            if (!e.classes || !e.courseId || courses.has(e.courseId)) continue;
            courses.add(e.courseId);
            current = courses.size;
        }
        if (!reachedOn && current >= goal - 1e-9) { reachedOn = clamp(e.day); value = current; }
    }
    if (type === "hours") { current = round1(current); value = round1(value); }
    return { type, goal, current, reached: !!reachedOn, reachedOn, value };
}

// Badges a person has reached and does not have yet.
function badgesDue(uid, rows, ctx, earnedBadgeIds) {
    const events = badgeEvents(uid, rows, ctx.courseById);
    const due = [];
    ctx.badges.forEach((b) => {
        if (b.archived === true || earnedBadgeIds.has(b.id)) return;   // archived badges are no longer awarded
        const r = badgeCheck(b, events, ctx.today);
        if (r && r.reached) due.push({ id: b.id, name: b.name || b.id, reachedOn: r.reachedOn, value: r.value });
    });
    return due;
}

// Creates the earned documents. create() only: an existing document is never touched.
async function createBadgeAwards(uid, due, trigger) {
    const awarded = [];
    const now = new Date();
    for (let i = 0; i < due.length; i += 20) {
        const chunk = due.slice(i, i + 20);
        const results = await Promise.allSettled(chunk.map((b) => {
            const noon = new Date(`${b.reachedOn}T12:00:00Z`);
            const when = isNaN(noon.getTime()) || noon > now ? now : noon;
            return db.collection("earnedAchievements").doc(`${uid}_${b.id}`).create({
                volunteerId: uid,
                badgeId: b.id,
                earnedAt: admin.firestore.Timestamp.fromDate(when),
                reachedOn: b.reachedOn,
                value: b.value,
                awardedBy: "auto",
                trigger: trigger || "auto",
                awardedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        }));
        results.forEach((r, k) => {
            if (r.status === "fulfilled") awarded.push(chunk[k].name);
            else if (!(r.reason && r.reason.code === 6)) throw r.reason; // 6 = ALREADY_EXISTS: awarded by another run
        });
    }
    return awarded;
}

async function badgeContext() {
    const [badgesSnap, coursesSnap] = await Promise.all([
        db.collection("achievementsBadges").get(),
        db.collection("course").get(),
    ]);
    return {
        badges: badgesSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
        courseById: new Map(coursesSnap.docs.map((d) => [d.id, d.data()])),
        today: londonDay(),
    };
}

// One person (the triggers).
async function awardBadgesFor(uid, source) {
    if (!uid) return [];
    const userSnap = await db.collection("users").doc(uid).get();
    if (!userSnap.exists) return [];
    const [ctx, earnedSnap, attSnap, hoursSnap, oneToOneSnap] = await Promise.all([
        badgeContext(),
        db.collection("earnedAchievements").where("volunteerId", "==", uid).get(),
        db.collection("attendanceRecords").where("userId", "==", uid).get(),
        db.collection("volunteerActivities").where("volunteerId", "==", uid).where("status", "==", "approved").get(),
        db.collection("oneToOneSessions").where("volunteerId", "==", uid).get(),
    ]);
    if (!ctx.badges.some((b) => b.archived !== true && BADGE_AUTO_TYPES.includes(b.type))) return [];
    const earned = new Set(earnedSnap.docs.map((d) => d.data().badgeId));
    const rows = {
        attendance: attSnap.docs.map((d) => d.data()),
        oneToOne: oneToOneSnap.docs.map((d) => d.data()),
        activities: hoursSnap.docs.map((d) => d.data()),
    };
    const due = badgesDue(uid, rows, ctx, earned);
    if (!due.length) return [];
    const awarded = await createBadgeAwards(uid, due, source);
    if (awarded.length) console.log(`[badges] ${uid}: awarded ${awarded.join(", ")} (${source})`);
    return awarded;
}

// Everyone (the recheck button and the nightly run). Every collection is read once.
async function recheckEveryone(trigger) {
    const [ctx, usersSnap, earnedSnap, attSnap, oneToOneSnap, hoursSnap] = await Promise.all([
        badgeContext(),
        db.collection("users").get(),
        db.collection("earnedAchievements").get(),
        db.collection("attendanceRecords").where("userId", ">", "").get(),   // teacher ticks only
        db.collection("oneToOneSessions").get(),
        db.collection("volunteerActivities").where("status", "==", "approved").get(),
    ]);
    const group = (docs, key) => {
        const m = new Map();
        docs.forEach((d) => { const x = d.data(); const k = x[key]; if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(x); });
        return m;
    };
    const att = group(attSnap.docs, "userId");
    const oto = group(oneToOneSnap.docs, "volunteerId");
    const acts = group(hoursSnap.docs, "volunteerId");
    const earnedBy = new Map();
    earnedSnap.docs.forEach((d) => {
        const e = d.data();
        if (!e.volunteerId) return;
        if (!earnedBy.has(e.volunteerId)) earnedBy.set(e.volunteerId, new Set());
        earnedBy.get(e.volunteerId).add(e.badgeId);
    });
    const results = [];
    let total = 0;
    for (const u of usersSnap.docs) {
        const rows = { attendance: att.get(u.id) || [], oneToOne: oto.get(u.id) || [], activities: acts.get(u.id) || [] };
        if (!rows.attendance.length && !rows.oneToOne.length && !rows.activities.length) continue;
        const due = badgesDue(u.id, rows, ctx, earnedBy.get(u.id) || new Set());
        if (!due.length) continue;
        const names = await createBadgeAwards(u.id, due, trigger);
        if (names.length) {
            const p = u.data();
            results.push({ name: String(p.displayName || p.name || p.email || u.id), archived: p.archived === true, badges: names });
            total += names.length;
        }
    }
    console.log(`[badges] ${trigger}: checked ${usersSnap.size} people, awarded ${total} badges to ${results.length} people`);
    return { checked: usersSnap.size, total, awarded: results };
}

exports.badgesOnAttendance = onDocumentCreated(
    { document: "attendanceRecords/{recordId}", region: "europe-west2" },
    async (event) => {
        const data = event.data && event.data.data();
        if (!data || !data.userId) return; // student marks do not earn teacher badges
        await awardBadgesFor(data.userId, "attendance");
    });

exports.badgesOnOneToOneSession = onDocumentCreated(
    { document: "oneToOneSessions/{sessionId}", region: "europe-west2" },
    async (event) => {
        const data = event.data && event.data.data();
        if (data && data.volunteerId) await awardBadgesFor(data.volunteerId, "1-2-1 session");
    });

exports.badgesOnHoursApproved = onDocumentUpdated(
    { document: "volunteerActivities/{activityId}", region: "europe-west2" },
    async (event) => {
        const before = event.data.before.data() || {};
        const after = event.data.after.data() || {};
        if (after.status === "approved" && before.status !== "approved" && after.volunteerId) {
            await awardBadgesFor(after.volunteerId, "hours");
        }
    });

// People with the Badges permission: check everyone now (catches up badges missed in the past,
// and new or edited badges). Returns { checked, total, awarded: [{ name, archived, badges }] }.
exports.recheckAllBadges = onCall({ timeoutSeconds: 540, memory: "512MiB" }, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be signed in.");
    if (!(await callerCan(request.auth.uid, "badges"))) {
        throw new HttpsError("permission-denied", "You need the Badges permission to recheck badges.");
    }
    return recheckEveryone("recheck");
});

// Every night, so months of service badges arrive without any new activity.
exports.badgesNightly = onSchedule(
    { schedule: "every day 03:00", timeZone: "Europe/London", timeoutSeconds: 540, memory: "512MiB" },
    async () => { await recheckEveryone("nightly"); });

// People with the Badges permission: award any badge by hand. { uid, badgeId, reason? }
exports.awardBadgeByHand = onCall(async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be signed in.");
    const me = await callerProfile(request.auth.uid);
    if (!userCan(me, "badges")) throw new HttpsError("permission-denied", "You need the Badges permission to award badges.");
    const uid = String((request.data && request.data.uid) || "").trim();
    const badgeId = String((request.data && request.data.badgeId) || "").trim();
    const reason = String((request.data && request.data.reason) || "").trim().slice(0, 500);
    if (!uid || !badgeId || uid.includes("/") || badgeId.includes("/")) throw new HttpsError("invalid-argument", "Choose a person and a badge.");
    const [userSnap, badgeSnap, hasSnap] = await Promise.all([
        db.collection("users").doc(uid).get(),
        db.collection("achievementsBadges").doc(badgeId).get(),
        db.collection("earnedAchievements").where("volunteerId", "==", uid).where("badgeId", "==", badgeId).limit(1).get(),
    ]);
    if (!userSnap.exists) throw new HttpsError("not-found", "This person could not be found.");
    if (!badgeSnap.exists) throw new HttpsError("not-found", "This badge could not be found.");
    if (badgeSnap.data().archived === true) throw new HttpsError("failed-precondition", "This badge is archived. Restore it first.");
    if (!hasSnap.empty) throw new HttpsError("already-exists", "This person already has this badge.");
    const byName = String(me.displayName || me.name || me.email || request.auth.uid);
    const today = londonDay();
    try {
        await db.collection("earnedAchievements").doc(`${uid}_${badgeId}`).create({
            volunteerId: uid,
            badgeId,
            earnedAt: admin.firestore.FieldValue.serverTimestamp(),
            reachedOn: today,
            manual: true,
            awardedBy: request.auth.uid,
            awardedByName: byName,
            ...(reason ? { reason } : {}),
        });
    } catch (e) {
        if (e.code === 6) throw new HttpsError("already-exists", "This person already has this badge.");
        throw e;
    }
    console.log(`[badges] ${request.auth.uid} awarded ${badgeId} to ${uid} by hand`);
    return { id: `${uid}_${badgeId}`, awardedByName: byName, reachedOn: today };
});

// Super admin only: withdraw a badge awarded by hand by mistake. { earnedId }
// Automatic awards cannot be withdrawn. A copy is kept in badgeWithdrawals.
exports.withdrawHandBadge = onCall(async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be signed in.");
    const me = await callerProfile(request.auth.uid);
    if (!me || me.archived === true || me.role !== "super_admin") {
        throw new HttpsError("permission-denied", "Only a super admin can withdraw a badge.");
    }
    const earnedId = String((request.data && request.data.earnedId) || "").trim();
    if (!earnedId || earnedId.includes("/")) throw new HttpsError("invalid-argument", "Choose the badge to withdraw.");
    const ref = db.collection("earnedAchievements").doc(earnedId);
    await db.runTransaction(async (t) => {
        const snap = await t.get(ref);
        if (!snap.exists) throw new HttpsError("not-found", "This award could not be found.");
        const e = snap.data();
        if (e.manual !== true) throw new HttpsError("failed-precondition", "Only a badge awarded by hand can be withdrawn.");
        t.set(db.collection("badgeWithdrawals").doc(), {
            earnedId, ...e,
            withdrawnBy: request.auth.uid,
            withdrawnByName: String(me.displayName || me.name || me.email || request.auth.uid),
            withdrawnAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        t.delete(ref);
    });
    console.log(`[badges] ${request.auth.uid} withdrew hand award ${earnedId}`);
    return { ok: true };
});

// ---------------------------------------------------------------------------
// ANNUAL LEAVE RESET (24 Sep 2026, rules updated 30 Sep 2026 by Franco)
// The leave year runs from 1 May to 30 April. The whole reset (every person plus the
// record of the run) is ONE transaction: all of it happens or none of it does.
//   - Only staff, admins and super admins have leave. Volunteers, people with no access
//     yet (standard_user) and archived people are left alone.
//   - New balance = the person's yearly entitlement (else their total, else 20)
//     + carry over, which is the days they still have left, at most 5, never negative.
//   - Every run is recorded in settings/leaveReset (the last run) and appended to
//     settings/leaveReset/runs/{auto id}.
//   - The automatic run (annualLeaveReset) only runs during May and only once per leave
//     year. A super admin can run it by hand at any time (resetAnnualLeaveNow); a second
//     run in the same leave year needs { confirmRepeat: true } (the portal warns first).
// ---------------------------------------------------------------------------
const LEAVE_BASE_ALLOWANCE = 20;
const LEAVE_MAX_CARRY_OVER = 5;
const LEAVE_ROLES = ["staff", "admin", "super_admin"];

function londonDateParts(date) {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" })
        .formatToParts(date).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
    return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

/** The year the current leave year started in (1 May), UK time. 30 Sep 2026 -> 2026, 10 Apr 2027 -> 2026. */
function currentLeaveYear(now) {
    const { year, month } = londonDateParts(now || new Date());
    return month >= 5 ? year : year - 1;
}

/** What the reset would give each person. Pure: used by the reset and by the preview. */
function leaveResetPlan(userDocs) {
    const out = [];
    userDocs.forEach((d) => {
        const u = d.data() || {};
        if (!LEAVE_ROLES.includes(u.role) || u.archived === true) return;
        const la = u.leaveAllowance || null;
        const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
        // No entitlement saved: the total minus this year's carry over and TOIL (never TOIL as entitlement).
        const fromTotal = num(la && la.total) == null ? null
            : Math.max(0, num(la.total) - (num(la.carriedOver) || 0) - (num(la.toilAdded) || 0));
        const entitlement = num(la && la.entitlement) ?? fromTotal ?? LEAVE_BASE_ALLOWANCE;
        const left = la ? num(la.remaining) : null;
        const carry = Math.min(Math.max(left || 0, 0), LEAVE_MAX_CARRY_OVER);
        out.push({
            ref: d.ref, uid: d.id, name: String(u.name || u.displayName || u.email || d.id), role: u.role,
            entitlement, daysLeftNow: left, carry, newBalance: entitlement + carry,
        });
    });
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The last recorded run, or null. Falls back to the marker the old reset wrote (settings/leave_management). */
async function lastLeaveReset(getter) {
    const [cur, old] = await Promise.all([
        getter(db.collection("settings").doc("leaveReset")),
        getter(db.collection("settings").doc("leave_management")),
    ]);
    if (cur.exists) {
        const d = cur.data();
        const at = d.lastRunAt && typeof d.lastRunAt.toDate === "function" ? d.lastRunAt.toDate().toISOString() : (d.lastRunAt || null);
        return { at, by: d.lastRunBy || "", manual: d.manual === true, leaveYear: Number(d.leaveYear) || 0, people: Number(d.people) || 0 };
    }
    if (old.exists && old.data().lastResetYear) {
        const d = old.data();
        return {
            at: d.lastRunAt || null, by: d.lastRunBy === "schedule" ? "automatic" : (d.lastRunBy || ""), manual: d.lastRunBy !== "schedule",
            leaveYear: Number(d.lastResetYear) || 0, people: Number(d.lastRunCount) || 0,
        };
    }
    return null;
}

async function runLeaveReset({ manual, byUid, confirmRepeat }) {
    const now = new Date();
    const leaveYear = currentLeaveYear(now);
    // The automatic run only happens in May, so deploying or a missing record can never
    // reset everyone in the middle of a leave year.
    if (!manual && londonDateParts(now).month !== 5) return { ran: false, reason: "The automatic reset only runs in May." };

    const settingsRef = db.collection("settings").doc("leaveReset");
    return db.runTransaction(async (tx) => {
        const last = await lastLeaveReset((ref) => tx.get(ref));
        const alreadyRun = !!last && last.leaveYear >= leaveYear;
        if (alreadyRun && !manual) return { ran: false, reason: `Already done for the leave year starting 1 May ${leaveYear}.` };
        if (alreadyRun && manual && !confirmRepeat) return { ran: false, alreadyRun: true, leaveYear, lastRun: last };

        const usersSnap = await tx.get(db.collection("users").where("role", "in", LEAVE_ROLES));
        const plan = leaveResetPlan(usersSnap.docs);
        plan.forEach((p) => {
            tx.update(p.ref, {
                leaveAllowance: { entitlement: p.entitlement, total: p.newBalance, remaining: p.newBalance, carriedOver: p.carry, year: leaveYear },
                updatedBy: manual ? (byUid || "system") : "system", updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        });
        const record = {
            lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
            lastRunBy: manual ? (byUid || "unknown") : "automatic",
            manual: !!manual, leaveYear, people: plan.length,
        };
        tx.set(settingsRef, record);
        tx.set(settingsRef.collection("runs").doc(), {
            ...record, repeat: alreadyRun,
            details: plan.map((p) => ({ uid: p.uid, name: p.name, entitlement: p.entitlement, daysLeftBefore: p.daysLeftNow, carriedOver: p.carry, newBalance: p.newBalance })),
        });
        return { ran: true, leaveYear, count: plan.length, repeat: alreadyRun };
    });
}

async function requireSuperAdmin(request, what) {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be signed in.");
    const me = await callerProfile(request.auth.uid);
    if (!me || me.role !== "super_admin" || me.archived === true) {
        throw new HttpsError("permission-denied", `Only a super admin can ${what}.`);
    }
}

exports.annualLeaveReset = onSchedule(
    { schedule: "every day 02:00", timeZone: "Europe/London" },
    async () => {
        const r = await runLeaveReset({ manual: false });
        console.log("[leave reset]", JSON.stringify(r));
    });

exports.resetAnnualLeaveNow = onCall(async (request) => {
    await requireSuperAdmin(request, "reset annual leave");
    const confirmRepeat = !!(request.data && request.data.confirmRepeat === true);
    return runLeaveReset({ manual: true, byUid: request.auth.uid, confirmRepeat });
});

// What the reset would do now, person by person, and when it last ran (super admin only).
exports.leaveResetPreview = onCall(async (request) => {
    await requireSuperAdmin(request, "see the leave reset");
    const [usersSnap, last] = await Promise.all([
        db.collection("users").where("role", "in", LEAVE_ROLES).get(),
        lastLeaveReset((ref) => ref.get()),
    ]);
    const leaveYear = currentLeaveYear();
    let lastRun = null;
    if (last) {
        let byName = "";
        if (last.by && last.by !== "automatic" && last.by !== "manual" && last.by !== "unknown") {
            const b = await db.collection("users").doc(last.by).get();
            byName = b.exists ? lmNameOf(b.data()) : "";
        }
        lastRun = { ...last, byName };
    }
    return {
        leaveYear,
        alreadyRunThisYear: !!last && last.leaveYear >= leaveYear,
        lastRun,
        people: leaveResetPlan(usersSnap.docs).map(({ ref, ...p }) => p),
    };
});

// Same as lmName further down (defined here too because this section comes first).
function lmNameOf(u) { return String((u && (u.name || u.displayName || u.email)) || ""); }

// ---------------------------------------------------------------------------
// VOLUNTEER RECRUITMENT (25 Sep 2026)
// ---------------------------------------------------------------------------
async function callerCanRecruit(uid) {
    return callerCan(uid, "volunteer_applications"); // honours switched-off permissions (30 Sep 2026)
}

// The CV is private in Storage (no one can read it directly); admins get it here.
exports.getVolunteerCv = onCall(async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be signed in.");
    if (!(await callerCanRecruit(request.auth.uid))) throw new HttpsError("permission-denied", "You cannot see volunteer applications.");
    const id = String((request.data && request.data.applicationId) || "");
    if (!/^[A-Za-z0-9]{10,40}$/.test(id)) throw new HttpsError("invalid-argument", "Unknown application.");
    const app = await db.collection("volunteer_applications").doc(id).get();
    if (!app.exists || !app.data().cvPath) throw new HttpsError("not-found", "This application has no CV.");
    const file = admin.storage().bucket().file(app.data().cvPath);
    const [buf] = await file.download();
    return { base64: buf.toString("base64"), name: app.data().cvName || "cv.pdf" };
});

// A new application (updated 29 Sep 2026):
// 1. tell the people ticked in recruitmentSettings/alerts (no list yet = all admins);
// 2. send the applicant a full copy of what they submitted, private answers included
//    (Franco's decision). Both from the recruitment mailbox.
// The statement texts copy src/lib/volunteerForm.ts MOTIVATIONS: change both together.
const VOL_MOTIVATIONS = [
    ["practicalSkills", "I would like to gain new practical skills."],
    ["lifeSkills", "I would like to gain improved life / social skills."],
    ["confidence", "I would like to increase my confidence."],
    ["employment", "I hope it would help to improve my employment options and opportunities."],
    ["university", "I hope it might help me at university or college."],
    ["engaged", "I hope it might help me to feel more engaged with my work or study."],
    ["leadership", "I would like to improve my leadership skills."],
    ["learning", "I want to keep on learning."],
    ["interests", "I hope it might spark some new interests."],
    ["meetPeople", "I hope I might meet some new people."],
];
const VOL_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const mailEsc = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));

// "09:00 to 10:00" + "10:00 to 11:00" -> "09:00 to 11:00"
function joinSlots(slots) {
    const list = [...(slots || [])].map(String).sort();
    const out = [];
    for (const s of list) {
        const [a, b] = s.split(" to ");
        const last = out[out.length - 1];
        if (last && last[1] === a) last[1] = b; else out.push([a, b]);
    }
    return out.map(([a, b]) => `${a} to ${b}`).join(", ");
}

// Questions added in the form editor (answers map) with the wording the applicant saw.
function extraAnswerLines(answers, labels) {
    if (!answers || typeof answers !== "object") return [];
    const q = (labels && labels.questions) || {};
    return Object.entries(answers)
        .filter(([k, v]) => !(k.endsWith("Other") && !v))
        .map(([k, v]) => {
            const base = k.endsWith("Other") ? k.slice(0, -5) : k;
            const label = k.endsWith("Other") ? `${q[base] || base} (other)` : (q[k] || k);
            const value = Array.isArray(v) ? v.join(", ") : (v && typeof v === "object") ? Object.entries(v).map(([x, y]) => `${x}: ${y}`).join("; ") : String(v == null ? "" : v);
            return `${label}: ${value || "No answer"}`;
        });
}

// sections: [{ title, lines: [string] }] -> { text, html }
function mailBody(intro, sections, outro) {
    const text = [intro, ...sections.map((s) => [s.title, ...s.lines].join("\n")), outro].join("\n\n");
    const p = (t) => `<p>${mailEsc(t).replace(/\n/g, "<br>")}</p>`;
    const html = intro.split("\n\n").map(p).join("")
        + sections.map((s) => `<h3 style="margin:18px 0 6px;font-size:15px;color:#1e293b">${mailEsc(s.title)}</h3>` + p(s.lines.join("\n"))).join("")
        + outro.split("\n\n").map(p).join("");
    return { text, html };
}

exports.volunteerApplicationReceived = onDocumentCreated(
    { document: "volunteer_applications/{appId}", region: "europe-west2" },
    async (event) => {
        const a = event.data && event.data.data();
        if (!a) return;
        const appId = event.params.appId;
        const FROM = "recruitment@sovereignhousegh.com";
        const valid = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

        // 1. The alert to the team.
        let to = [];
        try {
            const cfg = await db.collection("recruitmentSettings").doc("alerts").get();
            if (cfg.exists && Array.isArray(cfg.data().emails)) to = cfg.data().emails.map((e) => String(e).trim().toLowerCase()).filter(valid);
        } catch (e) { console.warn("alerts list", e.message); }
        if (!to.length) {
            const admins = await db.collection("users").where("role", "in", ["admin", "super_admin"]).get();
            to = admins.docs.map((d) => String(d.data().email || "").trim().toLowerCase()).filter(valid);
        }
        to = [...new Set(to)];
        if (to.length) {
            const link = `https://shgh-portal.web.app/recruitment/detail?id=${appId}`;
            const text = `A new volunteer application has arrived.\n\nName: ${a.name}\nRole: ${a.role}\nEmail: ${a.email}${a.phone ? `\nPhone: ${a.phone}` : ""}\nCV: ${a.cvPath ? "attached in the portal" : "none"}\n\nOpen it in the portal: ${link}`;
            await db.collection("mail").add({
                to, cc: [], subject: `New volunteer application: ${a.name} (${a.role})`,
                text, html: text.split("\n\n").map((p) => `<p>${mailEsc(p).replace(/\n/g, "<br>")}</p>`).join("").replace(mailEsc(link), `<a href="${link}">${mailEsc(link)}</a>`),
                kind: "new-application", applicationId: appId, from: FROM,
                status: "queued", createdBy: "system", createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        }

        // 2. The applicant's own copy.
        const email = String(a.email || "").trim().toLowerCase();
        if (!valid(email)) return;
        let eq = {};
        try { const p = await event.data.ref.collection("private").doc("equality").get(); if (p.exists) eq = p.data(); } catch (e) { console.warn("equality", e.message); }
        const first = String(a.name || "").trim().split(/\s+/)[0] || "there";
        const m = a.motivations || {};
        const av = a.availability || {};
        const sections = [
            { title: "About you", lines: [
                `Name: ${a.name || ""}`, `Email: ${a.email || ""}`, `Phone: ${a.phone || "not given"}`, `Age: ${a.age || ""}`, `Gender: ${a.gender || ""}`,
                `Nationality: ${eq.nationality || "not given"}`,
                `Ethnicity: ${eq.ethnicity === "Other" ? `Other: ${eq.ethnicityOther || ""}` : (eq.ethnicity || "not given")}`,
                `Disability: ${eq.disability || "not given"}`,
                `Role: ${a.role || ""}`,
                `How you heard about us: ${a.heardFrom === "Other" ? `Other: ${a.heardFromOther || ""}` : (a.heardFrom || "")}`,
            ] },
            ...(a.motivationText ? [{ title: "In your own words", lines: [String(a.motivationText)] }] : []),
            ...(extraAnswerLines(eq.answers, a.labels).length ? [{ title: "Private answers", lines: extraAnswerLines(eq.answers, a.labels) }] : []),
            { title: "Why you want to volunteer", lines: (a.labels && a.labels.statements && Object.keys(a.labels.statements).length
                ? Object.entries(a.labels.statements) : VOL_MOTIVATIONS).map(([k, t]) => `${t} ${m[k] || "No answer"}`) },
            ...(extraAnswerLines(a.answers, a.labels).length ? [{ title: "Your other answers", lines: extraAnswerLines(a.answers, a.labels) }] : []),
            { title: "Your weekly availability", lines: VOL_DAYS.map((d) => `${d}: ${(av[d] || []).length ? joinSlots(av[d]) : "not available"}`) },
            { title: "Your CV", lines: [a.cvPath ? `Received${a.cvName ? `: ${a.cvName}` : ""}` : "Not attached"] },
        ];
        const body = mailBody(
            `Dear ${first},\n\nThank you for applying to volunteer with Sovereign House GH as ${a.role}. We have received your application and we will be in touch soon.\n\nHere is a copy of what you sent us.`,
            sections,
            "If anything here is not right, just reply to this email and let us know.\n\nBest regards,\nSovereign House GH Team");
        if (!(await allowApplicantCopy(email))) { console.warn("[volunteerApplicationReceived] copy skipped: daily limit for this address"); return; }
        await db.collection("mail").add({
            to: [email], cc: [], subject: "Your volunteer application to Sovereign House GH",
            text: body.text, html: body.html,
            kind: "application-copy", applicationId: appId, from: FROM,
            status: "queued", createdBy: "system", createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
    });

// ---------------------------------------------------------------------------
// SEND QUEUED MAIL through Microsoft Graph as recruitment@sovereignhousegh.com.
// No client secret: the Sovereign House GH tenant blocks app secrets (28 Sep 2026).
// Instead the function proves who it is with a Google-signed ID token of its own
// service account (workload identity federation). Entra trusts that token through a
// federated credential on the "SHGH Portal mail" app registration:
//   issuer   https://accounts.google.com
//   subject  the unique ID of the functions' service account (see mailIdentity)
//   audience api://AzureADTokenExchange
// mailConfig/graph holds { tenantId, clientId, sender } (super_admin only).
// ---------------------------------------------------------------------------
// Always deployed (no secret needed). Until mailConfig/graph exists, mail waits.
// (An env-variable switch did not work: the CLI reads .env after it analyses the code.)
{
const FED_AUDIENCE = "api://AzureADTokenExchange";

// A Google ID token for this function's own service account, from the metadata server.
async function googleIdToken() {
    const url = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=" + encodeURIComponent(FED_AUDIENCE);
    const res = await fetch(url, { headers: { "Metadata-Flavor": "Google" } });
    if (!res.ok) throw new Error(`google identity ${res.status}`);
    return (await res.text()).trim();
}

function jwtClaims(t) {
    return JSON.parse(Buffer.from(String(t).split(".")[1] || "", "base64url").toString("utf8"));
}

async function graphToken(tenantId, clientId) {
    const assertion = await googleIdToken();
    const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: clientId,
            client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            client_assertion: assertion,
            scope: "https://graph.microsoft.com/.default",
            grant_type: "client_credentials",
        }),
    });
    const j = await res.json();
    if (!res.ok || !j.access_token) throw new Error(`token: ${j.error_description || j.error || res.status}`);
    return j.access_token;
}

async function sendOne(ref, m) {
    const cfgSnap = await db.collection("mailConfig").doc("graph").get();
    const cfg = cfgSnap.exists ? cfgSnap.data() : {};
    if (!cfg.tenantId || !cfg.clientId) {
        await ref.update({ status: "waiting", error: "The recruitment mailbox is not connected yet." });
        return;
    }
    const sender = cfg.sender || m.from || "recruitment@sovereignhousegh.com";
    const token = await graphToken(cfg.tenantId, cfg.clientId);
    const message = {
        subject: m.subject,
        body: { contentType: "HTML", content: m.html || m.text || "" },
        toRecipients: (m.to || []).map((a) => ({ emailAddress: { address: a } })),
        ccRecipients: (m.cc || []).map((a) => ({ emailAddress: { address: a } })),
    };
    if (m.ics) {
        message.attachments = [{ "@odata.type": "#microsoft.graph.fileAttachment", name: m.icsName || "invite.ics", contentType: "text/calendar", contentBytes: Buffer.from(m.ics, "utf8").toString("base64") }];
    }
    const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message, saveToSentItems: true }),
    });
    if (!res.ok) throw new Error(`sendMail ${res.status}: ${(await res.text()).slice(0, 300)}`);
    await ref.update({ status: "sent", sentAt: admin.firestore.FieldValue.serverTimestamp(), error: admin.firestore.FieldValue.delete() });
}

exports.sendQueuedMail = onDocumentCreated(
    { document: "mail/{mailId}", region: "europe-west2" },
    async (event) => {
        const m = event.data && event.data.data();
        if (!m || m.status !== "queued") return;
        try { await sendOne(event.data.ref, m); }
        catch (e) { console.error("[mail]", e); await event.data.ref.update({ status: "failed", error: String(e.message || e).slice(0, 300) }); }
    });

// Admin button: send everything that is waiting or failed (after the mailbox is connected).
exports.resendWaitingMail = onCall(async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be signed in.");
    if (!(await callerCanRecruit(request.auth.uid))) throw new HttpsError("permission-denied", "Not allowed.");
    const snap = await db.collection("mail").where("status", "in", ["waiting", "failed", "queued"]).get();
    const sys = await db.collection("systemMail").where("status", "in", ["waiting", "failed", "queued"]).get();
    let sent = 0, failed = 0;
    const errors = [];
    for (const d of [...snap.docs, ...sys.docs]) {
        try { await sendOne(d.ref, d.data()); if ((await d.ref.get()).data().status === "sent") sent++; }
        catch (e) { failed++; errors.push(String(e.message || e).slice(0, 300)); await d.ref.update({ status: "failed", error: String(e.message || e).slice(0, 300) }); }
    }
    return { sent, failed, total: snap.size + sys.size, firstError: errors[0] || null };
});

// Super admin only: the identity Entra must trust (the values for the federated credential).
// Nothing secret: issuer, subject (service account unique ID) and audience.
exports.mailIdentity = onCall(async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be signed in.");
    const me = await db.collection("users").doc(request.auth.uid).get();
    if (!me.exists || me.data().role !== "super_admin") throw new HttpsError("permission-denied", "Not allowed.");
    const c = jwtClaims(await googleIdToken());
    return { issuer: c.iss, subject: c.sub, audience: c.aud, azp: c.azp || null };
});
// 7 Oct 2026: moved inside this block. It sat just below the closing brace, where sendOne
// (declared inside the block) does not exist, so every systemMail email failed with
// "sendOne is not defined" (policy reminders 5 Oct, social media alerts 7 Oct).
exports.sendSystemMail = onDocumentCreated(
    { document: "systemMail/{mailId}", region: "europe-west2" },
    async (event) => {
        const m = event.data && event.data.data();
        if (!m || m.status !== "queued") return;
        try { await sendOne(event.data.ref, m); }
        catch (e) { console.error("[systemMail]", e); await event.data.ref.update({ status: "failed", error: String(e.message || e).slice(0, 300) }); }
    });
}

// Delete an application completely: the answers, the private equality data and the CV.

exports.deleteVolunteerApplication = onCall(async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be signed in.");
    if (!(await callerCanRecruit(request.auth.uid))) throw new HttpsError("permission-denied", "Not allowed.");
    const id = String((request.data && request.data.applicationId) || "");
    if (!/^[A-Za-z0-9]{10,40}$/.test(id)) throw new HttpsError("invalid-argument", "Unknown application.");
    const ref = db.collection("volunteer_applications").doc(id);
    const snap = await ref.get();
    if (!snap.exists) return { deleted: false };
    if (snap.data().cvPath) { try { await admin.storage().bucket().file(snap.data().cvPath).delete(); } catch (e) { console.warn("CV already gone", e.message); } }
    const priv = await ref.collection("private").get();
    // 30 Sep 2026: its emails go too (the applicant's copy holds their private answers).
    const mails = await db.collection("mail").where("applicationId", "==", id).get();
    const batch = db.batch();
    priv.forEach((d) => batch.delete(d.ref));
    mails.forEach((d) => batch.delete(d.ref));
    batch.delete(ref);
    await batch.commit();
    console.log(`deleteVolunteerApplication: ${request.auth.uid} deleted ${id}`);
    return { deleted: true };
});

// ---------------------------------------------------------------------------
// Line management (29 Sep 2026)
// A line manager is users/{uid}.managerId (set by a super admin, System > Line Managers).
// 1. leaveRequestCreated: emails the requester's line manager (or, with no line
//    manager, everyone who approves all leave) when a leave request arrives.
// 2. leaveRequestDecided: emails the requester when it is approved or rejected.
// 3. teamOverview: the people someone manages (everyone, for admins who ask), with
//    leave and policy reading. Policy reads come from the portal (policy_tracking.userId)
//    and the app (readConfirmations.volunteerId).
// 4. sendPolicyReminder: emails people their unread policies.
// 5. lineManagerChanged: moves pending leave requests to the new line manager and emails them.
// All mail goes out through the `mail` queue (sendQueuedMail) from recruitment@.
// ---------------------------------------------------------------------------
const PORTAL_URL = "https://shgh-portal.web.app";
const APP_URL = "https://shgh-lms1.web.app/";
const lmEsc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
const lmHtml = (text) => text.split("\n\n").map((p) => `<p>${lmEsc(p).replace(/\n/g, "<br>")}</p>`).join("");
const lmValid = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || ""));
const lmName = (u) => String((u && (u.displayName || u.name || u.email)) || "");
const lmFirst = (u) => lmName(u).trim().split(/\s+/)[0] || "there";
const lmDate = (d) => { const x = new Date(d); return isNaN(x.getTime()) ? String(d || "") : x.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" }); };

async function queueSystemMail(to, subject, text, kind, extra) {
    const list = [...new Set((to || []).map((e) => String(e).trim().toLowerCase()).filter(lmValid))];
    if (!list.length) return null;
    // 30 Sep 2026: leave emails go to systemMail, which no browser can read (the mail
    // collection is readable by recruiters).
    const ref = await db.collection("systemMail").add({
        to: list, cc: [], subject, text, html: lmHtml(text), kind, from: "recruitment@sovereignhousegh.com",
        status: "queued", createdBy: "system", createdAt: admin.firestore.FieldValue.serverTimestamp(), ...(extra || {}),
    });
    return ref.id;
}

async function leaveApproverEmails(managerId) {
    if (managerId) {
        const m = await db.collection("users").doc(managerId).get();
        if (m.exists && m.data().archived !== true && lmValid(m.data().email)) return [m.data().email];
    }
    // No line manager: everyone who approves all leave (admins, super admins, or the Approve Leave tick).
    const all = await db.collection("users").get();
    return all.docs.map((d) => d.data())
        .filter((u) => u.archived !== true)
        .filter((u) => u.role === "super_admin" || ((u.role === "admin" || (u.permissions || []).includes("leave_manage")) && !(u.deniedPermissions || []).includes("leave_manage")))
        .map((u) => u.email).filter(lmValid);
}

exports.leaveRequestCreated = onDocumentCreated(
    { document: "leave_records/{id}", region: "europe-west2" },
    async (event) => {
        const r = event.data && event.data.data();
        if (!r || r.status !== "pending") return;
        // An admin with no line manager approves their own leave (Franco, 29 Sep 2026):
        // someone with no line manager who can approve leave is emailed their own request.
        let to = null;
        if (!r.managerId) {
            const me = await db.collection("users").doc(r.userId).get();
            const u = me.exists ? me.data() : {};
            const approver = u.archived !== true && u.role === "super_admin" || ((u.role === "admin" || (u.permissions || []).includes("leave_manage")) && !(u.deniedPermissions || []).includes("leave_manage"));
            if (approver && lmValid(u.email)) to = [u.email];
        }
        if (!to) to = await leaveApproverEmails(r.managerId);
        const text = `A new leave request needs your decision.\n\nFrom: ${r.userName || ""}\nType: ${r.type || ""}\nFrom ${lmDate(r.startDate)} to ${lmDate(r.endDate)} (${r.totalDays} ${r.totalDays === 1 ? "day" : "days"})${r.reason ? `\nReason: ${r.reason}` : ""}\n\nApprove or reject it in the portal: ${PORTAL_URL}/leave/?tab=team`;
        await queueSystemMail(to, `Leave request from ${r.userName || "a colleague"}: ${lmDate(r.startDate)}`, text, "leave-request", { leaveId: event.params.id });
    });

exports.leaveRequestDecided = onDocumentUpdated(
    { document: "leave_records/{id}", region: "europe-west2" },
    async (event) => {
        const before = event.data.before.data() || {};
        const after = event.data.after.data() || {};
        if (before.status !== "pending" || !["approved", "rejected"].includes(after.status)) return;
        const u = await db.collection("users").doc(after.userId).get();
        if (!u.exists) return;
        const person = u.data();
        let by = "";
        if (after.approvedBy) { const a = await db.collection("users").doc(after.approvedBy).get(); if (a.exists) by = lmName(a.data()); }
        const la = person.leaveAllowance;
        const days = `${after.totalDays} ${after.totalDays === 1 ? "day" : "days"}`;
        const what = after.type === "toil" ? "TOIL claim" : `${after.type || ""} leave request`;
        let extra = "";
        if (after.status === "rejected" && after.rejectionReason) extra += `\n\nReason: ${after.rejectionReason}`;
        if (after.status === "approved" && after.type === "toil") extra += `\n\n${days} have been added to your leave balance.`;
        if (after.status === "approved" && la && (after.type === "annual" || after.type === "toil")) extra += `\n\nAnnual leave left this leave year: ${la.remaining} of ${la.total} days.`;
        const text = `Dear ${lmFirst(person)},\n\nYour ${what} from ${lmDate(after.startDate)} to ${lmDate(after.endDate)} (${days}) has been ${after.status}${by ? ` by ${by}` : ""}.${extra}\n\nYou can see all your leave in the portal: ${PORTAL_URL}/leave/\n\nBest regards,\nSovereign House GH Team`;
        await queueSystemMail([person.email], `Your ${after.type === "toil" ? "TOIL claim" : "leave request"} has been ${after.status}`, text, "leave-decision", { leaveId: event.params.id });
    });

// When someone's line manager changes (30 Sep 2026, Franco), their PENDING leave requests
// move to the new line manager, who is emailed the list. With no new line manager, the
// people who approve all leave are emailed instead (as for a new request).
exports.lineManagerChanged = onDocumentUpdated(
    { document: "users/{uid}", region: "europe-west2" },
    async (event) => {
        const before = event.data.before.data() || {};
        const after = event.data.after.data() || {};
        const oldId = String(before.managerId || "");
        const newId = String(after.managerId || "");
        if (oldId === newId) return;
        const snap = await db.collection("leave_records").where("userId", "==", event.params.uid).where("status", "==", "pending").get();
        const moved = snap.docs.filter((d) => String(d.data().managerId || "") !== newId);
        if (!moved.length) return;
        const batch = db.batch();
        moved.forEach((d) => batch.update(d.ref, { managerId: newId }));
        await batch.commit();
        const name = lmName(after) || "a colleague";
        const to = await leaveApproverEmails(newId);
        const lines = moved.map((d) => {
            const r = d.data();
            return `• ${r.type === "toil" ? "TOIL" : (r.type || "leave")}: ${lmDate(r.startDate)} to ${lmDate(r.endDate)} (${r.totalDays} ${r.totalDays === 1 ? "day" : "days"})`;
        }).join("\n");
        const intro = newId ? `You are now the line manager of ${name}.` : `${name} no longer has a line manager, so their requests now go to everyone who approves leave.`;
        const text = `${intro} ${moved.length === 1 ? "This leave request is" : "These leave requests are"} waiting for a decision:\n\n${lines}\n\nApprove or reject them in the portal: ${PORTAL_URL}/leave/?tab=team`;
        await queueSystemMail(to, `Leave ${moved.length === 1 ? "request" : "requests"} from ${name} moved to you`, text, "leave-moved", { userId: event.params.uid });
    });

// Who may see / remind whom: their own reports; admins, super admins and Approve Leave holders may see everyone.
async function lmCaller(uid) {
    const me = await db.collection("users").doc(uid).get();
    if (!me.exists) throw new HttpsError("permission-denied", "Your profile could not be found.");
    const d = me.data();
    if (d.archived === true) throw new HttpsError("permission-denied", "This account is archived.");
    // My Team is only for the super admin and admins (Franco, 29 Sep 2026).
    if (d.role !== "super_admin" && d.role !== "admin") throw new HttpsError("permission-denied", "My Team is for admins only.");
    const seesAll = d.role === "super_admin" || ((d.role === "admin" || (d.permissions || []).includes("leave_manage")) && !(d.deniedPermissions || []).includes("leave_manage"));
    return { uid, seesAll };
}

// Policy audience and version (30 Sep 2026, Franco):
//   policyResources/{id}.audience: 'staff' | 'volunteers' | 'everyone' (missing = everyone)
//   policyResources/{id}.version: a number (missing = 1)
// Staff, admins and super admins must read staff + everyone policies; volunteers read
// volunteers + everyone; anyone else only everyone. A read counts only when its version
// (missing = 1) is at least the policy's version.
function policyVersionOf(v) {
    // Same as src/lib/policies.ts policyVersion (1 Oct 2026): whole numbers, at least 1.
    const n = typeof v === "number" ? v : parseFloat(String(v == null ? "" : v));
    return isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}
function policyAudienceOf(a) {
    const s = String(a || "").trim().toLowerCase();
    if (s === "staff") return "staff";
    if (s === "volunteers" || s === "volunteer") return "volunteers";
    return "everyone";
}
function policyGroupOf(role) {
    if (["staff", "admin", "super_admin"].includes(String(role || "").trim().toLowerCase())) return "staff";
    if (role === "volunteer") return "volunteers";
    return "";
}

/** people: [{ id, role }]. Returns { [id]: { required, total, read, percent, unread: [titles] } }. */
async function policyStatusFor(people) {
    const [pol, portalReads, appReads] = await Promise.all([
        db.collection("policyResources").get(), db.collection("policy_tracking").get(), db.collection("readConfirmations").get(),
    ]);
    const policies = pol.docs.map((d) => ({
        id: d.id, title: String(d.data().title || "Policy"), audience: policyAudienceOf(d.data().audience), version: policyVersionOf(d.data().version),
    })).sort((a, b) => a.title.localeCompare(b.title));
    // read[user][policy] = the highest version read
    const read = {};
    const add = (u, p, v) => {
        if (!u || !p) return;
        const m = (read[u] = read[u] || {});
        m[p] = Math.max(m[p] || 0, policyVersionOf(v));
    };
    portalReads.forEach((d) => add(d.data().userId, d.data().policyId, d.data().version));
    appReads.forEach((d) => add(d.data().volunteerId, d.data().policyId || d.data().resourceId, d.data().version));
    const out = {};
    people.forEach(({ id, role }) => {
        const group = policyGroupOf(role);
        const required = policies.filter((p) => p.audience === "everyone" || (group && p.audience === group));
        const mine = read[id] || {};
        const done = required.filter((p) => (mine[p.id] || 0) >= p.version);
        const unread = required.filter((p) => !((mine[p.id] || 0) >= p.version)).map((p) => p.title);
        out[id] = {
            required: required.length, total: required.length, read: done.length,
            percent: required.length ? Math.round((done.length / required.length) * 100) : 100, unread,
        };
    });
    return out;
}

exports.teamOverview = onCall(async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be signed in.");
    const c = await lmCaller(request.auth.uid);
    const everyone = !!(request.data && request.data.everyone) && c.seesAll;
    const usersSnap = await db.collection("users").get();
    const people = usersSnap.docs.filter((d) => d.id !== c.uid && d.data().archived !== true && (everyone ? true : d.data().managerId === c.uid));
    const status = await policyStatusFor(people.map((d) => ({ id: d.id, role: d.data().role || "" })));
    const pending = {};
    const leaveSnap = await db.collection("leave_records").where("status", "==", "pending").get();
    leaveSnap.forEach((d) => { const u = d.data().userId; pending[u] = (pending[u] || 0) + 1; });
    const nameOf = Object.fromEntries(usersSnap.docs.map((d) => [d.id, lmName(d.data())]));
    return {
        seesAll: c.seesAll,
        people: people.map((d) => {
            const u = d.data();
            return {
                uid: d.id, name: lmName(u), email: u.email || "", role: u.role || "", managerName: nameOf[u.managerId] || "",
                archived: u.archived === true,
                leave: u.leaveAllowance ? { remaining: u.leaveAllowance.remaining, total: u.leaveAllowance.total } : null,
                pendingLeave: pending[d.id] || 0, policies: status[d.id],
            };
        }).sort((a, b) => a.name.localeCompare(b.name)),
    };
});

exports.sendPolicyReminder = onCall(async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be signed in.");
    const c = await lmCaller(request.auth.uid);
    const ids = Array.isArray(request.data && request.data.userIds) ? request.data.userIds.map(String).slice(0, 200) : [];
    if (!ids.length) throw new HttpsError("invalid-argument", "Nobody chosen.");
    const me = await db.collection("users").doc(c.uid).get();
    const from = lmName(me.data());
    const snaps = await Promise.all(ids.map((id) => db.collection("users").doc(id).get()));
    const status = await policyStatusFor(snaps.filter((u) => u.exists).map((u) => ({ id: u.id, role: u.data().role || "" })));
    let sent = 0, skipped = 0;
    for (const u of snaps) {
        const id = u.id;
        if (!u.exists || u.data().archived === true) { skipped++; continue; }
        const p = u.data();
        if (!c.seesAll && p.managerId !== c.uid) { skipped++; continue; }
        const unread = (status[id] && status[id].unread) || [];
        if (!unread.length || !lmValid(p.email)) { skipped++; continue; }
        const where = p.role === "volunteer" ? `Open the SHGH app, go to Policies and tap "Mark as read" on each one: ${APP_URL}` : `Read them in the portal under Policies: ${PORTAL_URL}/policies/`;
        const text = `Dear ${lmFirst(p)},\n\nThis is a reminder from ${from} to read the following ${unread.length === 1 ? "policy" : "policies"}:\n\n${unread.map((t) => `• ${t}`).join("\n")}\n\n${where}\n\nThank you,\nSovereign House GH Team`;
        await queueSystemMail([p.email], `Reminder: ${unread.length} ${unread.length === 1 ? "policy" : "policies"} to read`, text, "policy-reminder", { userId: id, sentBy: c.uid });
        sent++;
    }
    return { sent, skipped };
});

// ---------------------------------------------------------------------------
// ARCHIVE A PERSON (30 Sep 2026, Franco: keep history, never delete)
// Replaces "Delete" on the Volunteers page, which deleted the profile and left their
// assignments, badges and hours behind. Archiving:
//   - marks users/{uid} archived (lists and current counts leave them out; reports keep
//     their classes and hours);
//   - SUSPENDS the login (disabled, refresh tokens revoked). It is never deleted;
//   - takes them off courses that are still planned or running (finished courses keep
//     the assignment as history).
// Restoring re-enables the login. Admins and super admins can only be archived by a super admin.
// ---------------------------------------------------------------------------
exports.setPersonArchived = onCall(async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be signed in.");
    const caller = await callerProfile(request.auth.uid);
    if (!userCan(caller, "volunteers")) throw new HttpsError("permission-denied", "Archiving people needs the Volunteers permission.");
    const uid = String((request.data && request.data.uid) || "");
    const archived = !!(request.data && request.data.archived);
    if (!/^[A-Za-z0-9]{10,40}$/.test(uid)) throw new HttpsError("invalid-argument", "Unknown person.");
    if (uid === request.auth.uid) throw new HttpsError("failed-precondition", "You cannot archive yourself.");
    const ref = db.collection("users").doc(uid);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "That person has no profile.");
    const target = snap.data();
    if (["admin", "super_admin"].includes(target.role) && caller.role !== "super_admin") {
        throw new HttpsError("permission-denied", "Only a super admin can archive an admin.");
    }

    let assignmentsEnded = 0;
    if (archived) {
        const [asg, courses] = await Promise.all([
            db.collection("courseAssignments").where("volunteerId", "==", uid).get(),
            db.collection("course").get(),
        ]);
        const finished = new Set(courses.docs
            .filter((c) => ["completed", "cancelled"].includes(String(c.data().status || "").toLowerCase()))
            .map((c) => c.id));
        const batch = db.batch();
        asg.forEach((d) => {
            if (finished.has(d.data().courseId)) return;
            batch.delete(d.ref);
            assignmentsEnded++;
        });
        batch.set(ref, { archived: true, archivedAt: admin.firestore.Timestamp.now(), archivedBy: request.auth.uid }, { merge: true });
        await batch.commit();
    } else {
        await ref.set({ archived: false, archivedAt: admin.firestore.FieldValue.delete(), archivedBy: admin.firestore.FieldValue.delete(),
            restoredAt: admin.firestore.Timestamp.now(), restoredBy: request.auth.uid }, { merge: true });
    }

    let loginSuspended = false;
    try {
        await admin.auth().updateUser(uid, { disabled: archived });
        if (archived) await admin.auth().revokeRefreshTokens(uid);
        loginSuspended = archived;
    } catch (e) {
        if (e.code !== "auth/user-not-found") console.error("setPersonArchived: login change failed", e);
    }
    console.log(`setPersonArchived: ${request.auth.uid} set ${uid} archived=${archived} (${assignmentsEnded} assignments ended)`);
    return { assignmentsEnded, loginSuspended };
});

// ---------------------------------------------------------------------------
// STUDENT PRIVATE DETAILS, PHASE 3 ON THE SERVER (30 Sep 2026)
// dob, gpName, ethnicity, nationality and refugeeNumber must live only in
// studentsPrivate (staff and the Students permission). /students is readable by every
// signed-in account, volunteers in the app included, and phones on older app versions
// still write those fields there. This trigger moves them out as soon as they are
// written, whatever wrote them: a non-empty value is copied to studentsPrivate (the
// newest write wins, as in phase 2), then all five fields are removed from /students.
// ---------------------------------------------------------------------------
const STUDENT_PRIVATE_FIELDS = ["dob", "gpName", "ethnicity", "nationality", "refugeeNumber"];

async function moveStudentPrivate(studentRef, data) {
    const present = STUDENT_PRIVATE_FIELDS.filter((k) => Object.prototype.hasOwnProperty.call(data, k));
    if (!present.length) return false;
    const toCopy = {};
    present.forEach((k) => {
        const v = data[k];
        if (v !== null && v !== undefined && String(v).trim() !== "") toCopy[k] = v;
    });
    const batch = db.batch();
    if (Object.keys(toCopy).length) {
        batch.set(db.collection("studentsPrivate").doc(studentRef.id),
            { ...toCopy, movedFromStudentsAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    }
    const strip = {};
    present.forEach((k) => { strip[k] = admin.firestore.FieldValue.delete(); });
    batch.update(studentRef, strip);
    await batch.commit();
    return true;
}

exports.studentPrivateFields = onDocumentWritten(
    { document: "students/{studentId}", region: "europe-west2" },
    async (event) => {
        const after = event.data && event.data.after;
        if (!after || !after.exists) return;
        await moveStudentPrivate(after.ref, after.data() || {});
    });

// Super admin, once after the 30 Sep 2026 deploy (safe to run again):
//   1. moves the five private fields out of every existing student record;
//   2. removes the PIN from every Donated and Wasted inventory item (they were copied there).
exports.privateDataCleanup = onCall({ timeoutSeconds: 300 }, async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be signed in.");
    const me = await callerProfile(request.auth.uid);
    if (!me || me.role !== "super_admin") throw new HttpsError("permission-denied", "Only a super admin can run this.");
    // A backup first, readable by nobody from a browser (no rule matches it):
    // cleanupBackups/<run>/items/<collection>_<id> holds the values as they were.
    const run = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = db.collection("cleanupBackups").doc(run);
    await backup.set({ by: request.auth.uid, at: admin.firestore.FieldValue.serverTimestamp(), kind: "privateDataCleanup" });
    const snap = await db.collection("students").get();
    let moved = 0;
    for (const d of snap.docs) {
        const data = d.data();
        const fields = {};
        STUDENT_PRIVATE_FIELDS.forEach((k) => { if (Object.prototype.hasOwnProperty.call(data, k)) fields[k] = data[k]; });
        if (!Object.keys(fields).length) continue;
        const priv = await db.collection("studentsPrivate").doc(d.id).get();
        await backup.collection("items").doc(`students_${d.id}`).set({ students: fields, studentsPrivateBefore: priv.exists ? priv.data() : null });
        if (await moveStudentPrivate(d.ref, data)) moved++;
    }
    const stillHolding = (await db.collection("students").get()).docs
        .filter((d) => STUDENT_PRIVATE_FIELDS.some((k) => Object.prototype.hasOwnProperty.call(d.data(), k))).length;
    let pinsRemoved = 0;
    for (const name of ["donatedInventory", "wastedInventory"]) {
        const inv = await db.collection(name).get();
        for (const d of inv.docs) {
            if (Object.prototype.hasOwnProperty.call(d.data(), "pin")) {
                await backup.collection("items").doc(`${name}_${d.id}`).set({ pin: d.data().pin });
                await d.ref.update({ pin: admin.firestore.FieldValue.delete() });
                pinsRemoved++;
            }
        }
    }
    console.log(`privateDataCleanup by ${request.auth.uid}: ${moved} students moved, ${stillHolding} still holding, ${pinsRemoved} PINs removed`);
    return { students: snap.size, moved, stillHolding, pinsRemoved, backup: run };
});

// ---------------------------------------------------------------------------
// FEATURE MODULES (30 Sep 2026). Each file exports (ctx) => ({ exportName: function, ... }).
// A module that is not there yet is skipped; any other error stops the deploy.
// ---------------------------------------------------------------------------
{
    const ctx = {
        admin, db, onCall, HttpsError, onSchedule, onDocumentCreated, onDocumentUpdated, onDocumentWritten,
        userCan, callerProfile, callerCan, allowApplicantCopy,
        callerCanRecruit: typeof callerCanRecruit === "function" ? callerCanRecruit : undefined,
        queueSystemMail: typeof queueSystemMail === "function" ? queueSystemMail : undefined,
        sendOne: typeof sendOne === "function" ? sendOne : undefined,
    };
    for (const m of ["./studentApps.js", "./ghana.js", "./recruitment.js", "./people.js"]) {
        let mod = null;
        try { mod = require(m); } catch (e) {
            if (e.code === "MODULE_NOT_FOUND" && String(e.message).includes(m.slice(2))) continue;
            throw e;
        }
        Object.assign(exports, mod(ctx));
    }
}
