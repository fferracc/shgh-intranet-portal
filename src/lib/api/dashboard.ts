import { collection, query, where, getDocs, getDoc, doc, getCountFromServer, orderBy, limit } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { attendanceHeadline, courseAttendance, defaultHeadlineCourseIds, enrolledNow, isArchived, isDropIn, isFinished, isOneToOne, isRolling, isRunning, normRole, normType } from "@/lib/stats";
import { loadStatsData, StatsPart } from "@/lib/statsLoader";
import { UserProfile } from "@/lib/types";
import { can } from "@/lib/permissions";
import { myPolicyCompliance } from "@/lib/policies";
import { volunteerCounts } from "@/lib/activeVolunteers";

export const fetchDashboardStats = async (user: UserProfile | null) => {
    if (!user) return { pendingRequests: 0, policyCompliance: 0, totalPolicies: 0, readPolicies: 0, isApprover: false };

    // Leave approvals (29 Sep 2026): people with Approve Leave see every pending request;
    // a line manager sees the requests of the people they manage.
    let pendingRequests = 0;
    let isApprover = can(user, 'leave_manage');
    if (!isApprover) {
        try {
            const reports = await getDocs(query(collection(db, "users"), where("managerId", "==", user.uid), limit(1)));
            isApprover = !reports.empty;
        } catch { /* ignore */ }
    }
    if (isApprover) {
        try {
            const q = can(user, 'leave_manage')
                ? query(collection(db, "leave_records"), where("status", "==", "pending"))
                : query(collection(db, "leave_records"), where("managerId", "==", user.uid), where("status", "==", "pending"));
            pendingRequests = (await getCountFromServer(q)).data().count;
        } catch (e) {
            console.warn("Leave requests fetch failed", e);
        }
    }

    let totalPolicies = 0;
    let readPolicies = 0;
    let policyCompliance = 0;
    try {
        // Same rules as the Policies page (30 Sep 2026): only policies this person must read
        // (audience), current version only, portal and app reads merged, never over 100%.
        const mine = await myPolicyCompliance(user);
        totalPolicies = mine.total;
        readPolicies = mine.read;
        policyCompliance = mine.percent;
    } catch (e) {
        console.warn("Skipping policy stats fetch due to missing collection or permissions", e);
    }

    return { pendingRequests, policyCompliance, totalPolicies, readPolicies, isApprover };
};

export type PlatformCard = 'students' | 'volunteers' | 'courses' | 'inventory' | 'attendance';

// Platform Analytics are kept in sessionStorage for 10 minutes per person (30 Sep 2026), so
// moving around the portal does not read every collection again. "Refresh Data" skips it.
const CACHE_MS = 10 * 60 * 1000;
const cacheKey = (uid: string) => `shgh.dashboard.analytics.v1.${uid}`;

type PlatformResult = Awaited<ReturnType<typeof computePlatformStats>>;
export type PlatformStatsResult = PlatformResult & { at: number };

/** Admins only. `fresh` bypasses the 10 minute cache. The result carries `at` (ms), when the figures were read. */
export const fetchPlatformStats = async (user: UserProfile | null, opts: { fresh?: boolean } = {}): Promise<PlatformStatsResult | null> => {
    if (!user || !['super_admin', 'admin'].includes(user.role?.toLowerCase())) return null;
    const key = cacheKey(user.uid);
    if (!opts.fresh) {
        try {
            const raw = sessionStorage.getItem(key);
            if (raw) {
                const hit = JSON.parse(raw) as PlatformStatsResult;
                if (hit && typeof hit.at === 'number' && Date.now() - hit.at < CACHE_MS && hit.platformStats) return hit;
            }
        } catch { /* no storage, or a broken entry: read fresh */ }
    }
    const result: PlatformStatsResult = { ...(await computePlatformStats()), at: Date.now() };
    try {
        // A result with a failed card is not kept, so the next visit tries again.
        if (Object.keys(result.errors).length === 0) sessionStorage.setItem(key, JSON.stringify(result));
        else sessionStorage.removeItem(key);
    } catch { /* storage full or blocked: nothing to do */ }
    return result;
};

// Platform Analytics (30 Sep 2026): every figure comes from src/lib/stats.ts, so it matches
// the other pages. A card whose reads failed says "Could not load" instead of showing 0.
const computePlatformStats = async () => {
    const { data, failed } = await loadStatsData(['courses', 'students', 'users', 'roster', 'assignments', 'attendance', 'oneToOne', 'activities']);
    const needs: Record<Exclude<PlatformCard, 'inventory'>, StatsPart[]> = {
        students: ['students', 'roster', 'courses'],
        volunteers: ['users', 'courses', 'attendance', 'oneToOne', 'activities'],
        courses: ['courses'],
        attendance: ['courses', 'attendance', 'roster', 'students'],
    };
    const errors: Partial<Record<PlatformCard, boolean>> = {};
    (Object.keys(needs) as (keyof typeof needs)[]).forEach(k => { if (needs[k].some(p => failed.includes(p))) errors[k] = true; });

    // Students
    const students = data.students || [];
    const enrolled = enrolledNow(data).length;
    const under18 = students.filter(s => s.age && Number(s.age) < 18);
    const over18 = students.filter(s => s.age && Number(s.age) >= 18);
    const under18Avg = under18.length > 0 ? Math.round(under18.reduce((a, s) => a + Number(s.age), 0) / under18.length) : 0;
    const over18Avg = over18.length > 0 ? Math.round(over18.reduce((a, s) => a + Number(s.age), 0) / over18.length) : 0;

    // Courses
    const courses = data.courses;
    const activeRolling = courses.filter(c => isRunning(c) && isRolling(c)).length;
    const activeDropIn = courses.filter(c => isRunning(c) && isDropIn(c)).length;
    const finished = courses.filter(isFinished).length;

    // Volunteers (Users)
    const allUsers = data.users || [];
    // Active in the last 90 days (any role), registered volunteers and historic: src/lib/activeVolunteers.ts
    const vc = volunteerCounts(data);
    const admins = allUsers.filter(u => !isArchived(u) && ['super_admin', 'admin'].includes(normRole(u.role))).length;

    // Inventory 
    let inventoryItems: any[] = [];
    let locationStats: any[] = [];
    let typeStats: any[] = [];
    let activityStats: any[] = [];
    try {
        const inventorySnap = await getDocs(collection(db, "laptopInventory"));
        inventoryItems = inventorySnap.docs.map(d => d.data());
        const locationMap: Record<string, number> = {};
        const typeMap: Record<string, number> = {};
        const activityMap: Record<string, number> = {};
        inventoryItems.forEach(item => {
            const loc = item.location || 'Unknown';
            const type = item.type || 'Unknown';
            const act = item.activity || 'Unknown';
            locationMap[loc] = (locationMap[loc] || 0) + 1;
            typeMap[type] = (typeMap[type] || 0) + 1;
            activityMap[act] = (activityMap[act] || 0) + 1;
        });
        locationStats = Object.entries(locationMap).map(([location, count]) => ({ location, count })).sort((a, b) => b.count - a.count);
        typeStats = Object.entries(typeMap).map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count);
        activityStats = Object.entries(activityMap).map(([activity, count]) => ({ activity, count })).sort((a, b) => b.count - a.count);
    } catch (e) {
        console.warn("Inventory fetch failed.", e);
        errors.inventory = true;
    }

    // Attendance: fair per-course rates (src/lib/attendanceRates.ts through src/lib/stats.ts).
    const perCourse = courseAttendance(data);
    const attendanceData = courses
        .filter(c => !isOneToOne(c)) // 1-2-1 courses log sessions, not attendance
        .map(c => {
            const d = perCourse[c.id] || { sessions: 0, present: 0, expected: 0, rate: null, duplicatesIgnored: 0 };
            const cName = c.name || 'Unknown';
            const cCode = c.code || '';
            return {
                id: c.id,
                code: cCode,
                name: cCode ? `${cCode}` : (cName.length > 15 ? cName.slice(0, 15) + '…' : cName),
                fullName: cName,
                type: normType(c.type),
                status: c.status || '',
                running: isRunning(c),
                sessions: d.sessions,
                present: d.present,
                possible: d.expected,
                rate: d.rate,
                value: d.rate ?? 0,
            };
        })
        .sort((a, b) => (a.code || '').localeCompare(b.code || ''));
    const headline = attendanceHeadline(perCourse, defaultHeadlineCourseIds(courses));

    return {
        locationStats,
        typeStats,
        activityStats,
        errors,
        platformStats: {
            students: { total: students.length, enrolled, under18Avg, over18Avg },
            courses: { total: courses.length, activeRolling, activeDropIn, finished },
            volunteers: { totalUsers: allUsers.length, activeVolunteers: vc.active, activeDays: vc.activeDays, registeredVolunteers: vc.registered, historicVolunteers: vc.historic, admins },
            inventory: { total: inventoryItems.length },
            attendance: { rate: headline.rate ?? 0, data: attendanceData },
        },
    };
};
