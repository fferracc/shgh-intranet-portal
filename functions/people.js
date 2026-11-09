// ---------------------------------------------------------------------------
// PEOPLE AND PERMISSIONS, server side (1 Oct 2026). Loaded by index.js (FEATURE MODULES).
//
// usersChangeLog          Trigger on users/{uid}: every change to role, permissions,
//                         deniedPermissions, managerId, archived or leaveAllowance.entitlement
//                         is written to changeLog (one document per field). Only the server
//                         writes changeLog; admins and super admins read it in the portal
//                         (Users & Permissions). Who made the change comes from updatedBy on
//                         the user document, but only when that write also changed updatedAt
//                         or updatedBy (so an old stamp is never reused for someone else's
//                         change). Archiving uses archivedBy / restoredBy written by
//                         setPersonArchived. Anything else is "unknown".
// publicProfileMirror     Trigger on users/{uid}: keeps publicProfiles/{uid} = the name, photo,
//                         role and archived flag only, so volunteers in the app can see who is
//                         who without reading emails, phones or personal fields.
//                         Deleting the user deletes the public profile.
// rebuildPublicProfiles   Callable, super admin only: fills publicProfiles for everyone once
//                         and removes public profiles whose user no longer exists.
// ---------------------------------------------------------------------------
module.exports = (ctx) => {
    const { admin, db, onCall, HttpsError, onDocumentWritten, callerProfile } = ctx;
    const REGION = "europe-west2";
    const FieldValue = admin.firestore.FieldValue;

    // ----- change log -------------------------------------------------------
    const TRACKED = ["role", "permissions", "deniedPermissions", "managerId", "archived", "leaveAllowance.entitlement"];

    function readField(d, field) {
        if (!d) return undefined;
        if (field === "leaveAllowance.entitlement") {
            const la = d.leaveAllowance;
            return la && typeof la === "object" ? la.entitlement : undefined;
        }
        return d[field];
    }

    // A missing value and its empty form mean the same thing ([] for lists, "" for managerId,
    // false for archived), so they never count as a change. Firestore cannot store undefined.
    function norm(field, v) {
        if (field === "permissions" || field === "deniedPermissions") {
            const list = Array.isArray(v) ? v.map((x) => String(x)) : [];
            return list.length ? list : null;
        }
        if (field === "archived") return v === true;
        if (field === "managerId" || field === "role") {
            const s = v == null ? "" : String(v);
            return s ? s : null;
        }
        if (field === "leaveAllowance.entitlement") {
            return typeof v === "number" && isFinite(v) ? v : null;
        }
        return v === undefined ? null : v;
    }

    function same(field, a, b) {
        if (field === "permissions" || field === "deniedPermissions") {
            const x = (a || []).slice().sort().join("|");
            const y = (b || []).slice().sort().join("|");
            return x === y;
        }
        return a === b;
    }

    function stampKey(v) {
        if (v == null) return "";
        if (typeof v.toMillis === "function") return String(v.toMillis()) + ":" + String(v.nanoseconds || 0);
        if (typeof v.seconds === "number") return String(v.seconds) + ":" + String(v.nanoseconds || 0);
        return String(v);
    }

    function personName(d, uid) {
        const x = d || {};
        return String(x.name || x.displayName || x.email || uid);
    }

    const usersChangeLog = onDocumentWritten(
        { document: "users/{uid}", region: REGION },
        async (event) => {
            const uid = event.params.uid;
            const beforeSnap = event.data && event.data.before;
            const afterSnap = event.data && event.data.after;
            const before = beforeSnap && beforeSnap.exists ? beforeSnap.data() : null;
            const after = afterSnap && afterSnap.exists ? afterSnap.data() : null;
            if (!before && !after) return;

            // The stamp counts only when this write set it.
            const stamped = !!after && !!after.updatedBy && (
                !before
                || stampKey(after.updatedAt) !== stampKey(before.updatedAt)
                || String(after.updatedBy || "") !== String(before.updatedBy || "")
            );
            const stampBy = stamped ? String(after.updatedBy) : "";

            const changes = [];
            for (const field of TRACKED) {
                const b = norm(field, readField(before, field));
                const a = norm(field, readField(after, field));
                if (same(field, b, a)) continue;
                let byUid = stampBy;
                if (!byUid && field === "archived" && after) {
                    byUid = String((a ? after.archivedBy : after.restoredBy) || "");
                }
                changes.push({ field, before: b, after: a, byUid: byUid || "unknown" });
            }
            if (!changes.length) return;

            const targetName = personName(after || before, uid);
            const batch = db.batch();
            changes.forEach((c) => {
                batch.set(db.collection("changeLog").doc(), {
                    at: FieldValue.serverTimestamp(),
                    targetUid: uid,
                    targetName,
                    field: c.field,
                    before: c.before,
                    after: c.after,
                    byUid: c.byUid,
                    source: "users",
                });
            });
            await batch.commit();
        });

    // ----- public directory -------------------------------------------------
    function publicOf(d) {
        const x = d || {};
        const name = String(x.name || x.displayName || "");
        return {
            name,
            displayName: String(x.displayName || x.name || ""),
            photo: String(x.profilePicUrl || x.photoURL || ""),
            role: String(x.role || ""),
            archived: x.archived === true,
        };
    }
    function samePublic(a, b) {
        return a.name === b.name && a.displayName === b.displayName && a.photo === b.photo
            && a.role === b.role && a.archived === b.archived;
    }

    const publicProfileMirror = onDocumentWritten(
        { document: "users/{uid}", region: REGION },
        async (event) => {
            const uid = event.params.uid;
            const ref = db.collection("publicProfiles").doc(uid);
            const beforeSnap = event.data && event.data.before;
            const afterSnap = event.data && event.data.after;
            if (!afterSnap || !afterSnap.exists) {
                await ref.delete();
                return;
            }
            const next = publicOf(afterSnap.data());
            // Most writes (chat read times, profile details) do not touch these fields.
            if (beforeSnap && beforeSnap.exists && samePublic(publicOf(beforeSnap.data()), next)) return;
            await ref.set({ ...next, updatedAt: FieldValue.serverTimestamp() });
        });

    const rebuildPublicProfiles = onCall({ timeoutSeconds: 300 }, async (request) => {
        if (!request.auth) throw new HttpsError("unauthenticated", "You must be signed in.");
        const me = await callerProfile(request.auth.uid);
        if (!me || me.archived === true || me.role !== "super_admin") {
            throw new HttpsError("permission-denied", "Only a super admin can rebuild the public directory.");
        }
        const [users, existing] = await Promise.all([
            db.collection("users").get(),
            db.collection("publicProfiles").get(),
        ]);
        const live = new Set(users.docs.map((d) => d.id));
        const ops = [];
        users.docs.forEach((d) => {
            ops.push((b) => b.set(db.collection("publicProfiles").doc(d.id), { ...publicOf(d.data()), updatedAt: FieldValue.serverTimestamp() }));
        });
        let removed = 0;
        existing.docs.forEach((d) => {
            if (live.has(d.id)) return;
            removed++;
            ops.push((b) => b.delete(d.ref));
        });
        for (let i = 0; i < ops.length; i += 400) {
            const batch = db.batch();
            ops.slice(i, i + 400).forEach((op) => op(batch));
            await batch.commit();
        }
        console.log(`rebuildPublicProfiles by ${request.auth.uid}: ${users.size} written, ${removed} removed`);
        return { written: users.size, removed };
    });

    return { usersChangeLog, publicProfileMirror, rebuildPublicProfiles };
};
