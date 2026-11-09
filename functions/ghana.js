// ---------------------------------------------------------------------------
// GHANA OPERATIONS, READ ON THE SERVER (30 Sep 2026)
//
// The portal used to sign in ANONYMOUSLY to the Ghana project (shgh-attendance-redesign)
// and read its `portalPublic` snapshot straight from the browser. Anonymous sign-in with
// the public API key is open to anyone, so the children's names in that snapshot were in
// effect public. Franco's decision: the portal SERVER reads the Ghana data, and only for
// people who hold the Ghana Operations permission (ghana_ops). Once this is live, the
// Ghana project's Anonymous provider is switched off and portalPublic needs a real login.
//
// Access: this function runs as the shgh-lms1 default compute service account
// (000000000000-compute@developer.gserviceaccount.com). That account must be granted
// "Cloud Datastore Viewer" (roles/datastore.viewer) on shgh-attendance-redesign, once,
// in the Google Cloud console. Until then every read fails with PERMISSION_DENIED and the
// page shows the instructions. Read only: nothing here writes to the Ghana project.
//
// Input:  { source?: 'snapshot' }   ('live' is reserved for later, see the note below)
// Output: { source, updatedAt, summaryUpdatedAt, summary, classes[] }
//   classes[] = { id, code, name, enrolled, roster[], teacherIds[], names{id:name},
//                 days{ 'YYYY-MM-DD': {p[],l[],a[],t[],v} }, updatedAt }
//   Only ids and names ever leave this function; archived classes are dropped, and a
//   name is returned only for an id that appears on that class's roster, teacher list or
//   registers.
//
// NOT BUILT YET: a { source: 'live' } path computing the same shape from the real Ghana
// collections (course, courseRoster, attendanceRecords, students, users). The exact field
// names of v2 register rows (status strings, teacher rows) and of course / user / student
// names are not confirmed, and a wrong guess would show wrong attendance figures, so that
// path refuses with "unimplemented" rather than guess. The snapshot is what the Ghana app
// already publishes, so the app needs no change.
// ---------------------------------------------------------------------------

const GHANA_PROJECT_ID = "shgh-attendance-redesign";
const GHANA_APP_NAME = "ghana";
const NOT_GRANTED_MESSAGE =
    "The portal is not yet allowed to read the Ghana project. Franco needs to grant access once (see instructions).";

module.exports = (ctx) => {
    const { admin, onCall, HttpsError, callerCan } = ctx;
    const { getFirestore } = require("firebase-admin/firestore");

    let ghanaDb = null;
    function ghanaFirestore() {
        if (ghanaDb) return ghanaDb;
        const existing = (admin.apps || []).find((a) => a && a.name === GHANA_APP_NAME);
        const app = existing || admin.initializeApp({ projectId: GHANA_PROJECT_ID }, GHANA_APP_NAME);
        ghanaDb = getFirestore(app);
        return ghanaDb;
    }

    const isDenied = (e) => {
        const code = e && e.code;
        const msg = String((e && (e.details || e.message)) || "");
        return code === 7 || code === 16 || code === "permission-denied" ||
            /PERMISSION_DENIED|UNAUTHENTICATED|insufficient permissions/i.test(msg);
    };

    const asIds = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" || typeof x === "number").map(String) : []);

    const toIso = (v) => {
        if (!v) return null;
        if (typeof v === "string") { const d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString(); }
        if (typeof v.toDate === "function") return v.toDate().toISOString();
        if (v instanceof Date) return v.toISOString();
        if (typeof v.seconds === "number") return new Date(v.seconds * 1000).toISOString();
        if (typeof v._seconds === "number") return new Date(v._seconds * 1000).toISOString();
        return null;
    };

    const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

    function cleanClass(docId, data) {
        const rawDays = data.days && typeof data.days === "object" ? data.days : {};
        const days = {};
        const referenced = new Set();
        const roster = asIds(data.roster);
        const teacherIds = asIds(data.teacherIds);
        roster.forEach((id) => referenced.add(id));
        teacherIds.forEach((id) => referenced.add(id));
        Object.keys(rawDays).forEach((date) => {
            if (!DATE_KEY.test(date)) return;
            const d = rawDays[date] || {};
            const day = { p: asIds(d.p), l: asIds(d.l), a: asIds(d.a), t: asIds(d.t), v: d.v === true };
            [...day.p, ...day.l, ...day.a, ...day.t].forEach((id) => referenced.add(id));
            days[date] = day;
        });
        const rawNames = data.names && typeof data.names === "object" ? data.names : {};
        const names = {};
        referenced.forEach((id) => {
            const n = rawNames[id];
            if (typeof n === "string" && n.trim()) names[id] = n.trim().slice(0, 120);
        });
        return {
            id: String(data.courseId || docId.slice("class_".length)),
            code: typeof data.code === "string" ? data.code : "",
            name: typeof data.name === "string" && data.name ? data.name : "Unnamed class",
            enrolled: Number(data.enrolled) || 0,
            roster,
            teacherIds,
            names,
            days,
            updatedAt: toIso(data.updatedAt),
        };
    }

    async function readSnapshot() {
        const snap = await ghanaFirestore().collection("portalPublic").get();
        let summary = { totalStudents: 0, enrolledStudents: 0, teacherCount: 0 };
        let summaryUpdatedAt = null;
        const classes = [];
        snap.docs.forEach((d) => {
            const data = d.data() || {};
            if (d.id === "summary") {
                summary = {
                    totalStudents: Number(data.totalStudents) || 0,
                    enrolledStudents: Number(data.enrolledStudents) || 0,
                    teacherCount: Number(data.teacherCount) || 0,
                };
                summaryUpdatedAt = toIso(data.updatedAt);
                return;
            }
            if (!d.id.startsWith("class_")) return;
            if (data.archived === true) return;
            classes.push(cleanClass(d.id, data));
        });
        // Freshness: the latest publish anywhere in the snapshot. A register publishes its
        // own class document, so the summary alone can look older than the figures are.
        let updatedAt = summaryUpdatedAt;
        classes.forEach((c) => { if (c.updatedAt && (!updatedAt || c.updatedAt > updatedAt)) updatedAt = c.updatedAt; });
        return { source: "snapshot", empty: snap.empty, updatedAt, summaryUpdatedAt, summary, classes };
    }

    const ghanaOverview = onCall({ timeoutSeconds: 60 }, async (request) => {
        if (!request.auth) throw new HttpsError("unauthenticated", "Please sign in to the portal first.");
        // Portal staff only (1 Oct 2026 review): volunteers hold ghana_ops by default for the
        // app, but children's names are for staff, admins and the super admin.
        const me = await ctx.callerProfile(request.auth.uid);
        if (!me || !["staff", "admin", "super_admin"].includes(me.role) || !(await callerCan(request.auth.uid, "ghana_ops"))) {
            throw new HttpsError("permission-denied", "You do not have the Ghana Operations permission.");
        }
        const source = request.data && request.data.source ? String(request.data.source) : "snapshot";
        if (source === "live") {
            throw new HttpsError("unimplemented", "Reading the live Ghana collections is not built yet. The published snapshot is used instead.");
        }
        if (source !== "snapshot") throw new HttpsError("invalid-argument", "Unknown source.");
        try {
            return await readSnapshot();
        } catch (e) {
            if (isDenied(e)) {
                console.warn("ghanaOverview: the Ghana project refused the read (IAM not granted yet?)", e.message || e);
                throw new HttpsError("failed-precondition", NOT_GRANTED_MESSAGE, { reason: "ghana_access_not_granted" });
            }
            console.error("ghanaOverview failed", e);
            throw new HttpsError("internal", "Could not read the Ghana statistics. Please try again later.");
        }
    });

    return { ghanaOverview };
};
