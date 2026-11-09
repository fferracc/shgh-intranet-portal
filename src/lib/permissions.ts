/**
 * Feature permissions for the Intranet Portal and the UK mobile app.
 *
 * Model: ADDITIVE.
 *   Effective access = what the user's role grants by default
 *                      OR an explicit key in users/{uid}.permissions
 *
 * Nothing is ever taken away by this file, so every existing account keeps
 * exactly the access it had before permissions existed. Only a super_admin
 * can write the `permissions` field (enforced in firestore.rules).
 */

import { UserRole } from "./types";

export type PermissionKey =
    | 'students'
    | 'courses'
    | 'class_reports'
    | 'calendar'
    | 'ghana_ops'
    | 'statistics'
    | 'volunteers'
    | 'badges'
    | 'volunteer_applications'
    | 'student_applications'
    | 'announcements'
    | 'social_media'
    | 'grants'
    | 'inventory'
    | 'leave_manage'
    | 'app_admin';

/** Label and grouping for the super admin permissions screen. */
export const PERMISSION_CATALOG: {
    key: PermissionKey;
    label: string;
    group: string;
    description: string;
}[] = [
        { key: 'students', label: 'Students', group: 'Academy', description: 'View and edit student records' },
        { key: 'courses', label: 'Courses', group: 'Academy', description: 'View and edit courses and registers' },
        { key: 'class_reports', label: 'Class Reports', group: 'Academy', description: 'View attendance and class reporting' },
        { key: 'calendar', label: 'Calendar', group: 'Academy', description: 'View the shared class calendar' },
        { key: 'ghana_ops', label: 'Ghana Operations', group: 'Academy', description: 'View the Ghana operations dashboard' },
        { key: 'statistics', label: 'Statistics', group: 'Academy', description: 'Master statistics page and report builder' },
        { key: 'volunteers', label: 'Volunteers', group: 'People', description: 'Manage the volunteer list and volunteer records' },
        { key: 'badges', label: 'Badges', group: 'People', description: 'Manage badges and awards' },
        { key: 'volunteer_applications', label: 'Volunteer Applications', group: 'Recruitment', description: 'Process incoming volunteer applications' },
        { key: 'student_applications', label: 'Student Applications', group: 'Recruitment', description: 'Process incoming student and refugee applications' },
        { key: 'announcements', label: 'Announcements', group: 'Communications', description: 'Publish announcements to all users' },
        { key: 'social_media', label: 'Social Media', group: 'Communications', description: 'Social media dashboard and content plan' },
        { key: 'grants', label: 'Grants and Funding', group: 'Funding', description: 'Grant finder and funding reports' },
        { key: 'inventory', label: 'Inventory', group: 'Operations', description: 'Laptop and equipment inventory' },
        { key: 'leave_manage', label: 'Approve Leave', group: 'Operations', description: 'Approve or reject leave for other people' },
        { key: 'app_admin', label: 'Mobile App Admin', group: 'Mobile App', description: 'Full control of courses, teachers, volunteers and students in the UK mobile app' },
    ];

export const ALL_PERMISSIONS: PermissionKey[] = PERMISSION_CATALOG.map(p => p.key);

/**
 * What each role gets with no explicit permissions set.
 * These mirror the access each role already had before this file existed.
 * super_admin is deliberately absent: it is handled as "everything" in can().
 */
export const ROLE_DEFAULTS: Record<UserRole, PermissionKey[]> = {
    super_admin: ALL_PERMISSIONS,
    admin: [
        'students', 'courses', 'class_reports', 'calendar', 'ghana_ops', 'statistics',
        'volunteers', 'badges',
        'volunteer_applications', 'student_applications',
        'announcements', 'social_media', 'grants',
        'inventory', 'leave_manage', 'app_admin',
    ],
    // 29 Sep 2026 (Franco): Ghana Operations is not part of staff by default; tick it per person if needed.
    staff: ['students', 'courses', 'class_reports', 'calendar', 'inventory'],
    line_manager: ['inventory', 'leave_manage'],
    standard_user: [],
    volunteer: ['class_reports', 'calendar', 'ghana_ops'],
};

/** The minimum shape can() needs. Works with UserProfile and with a raw Firestore doc. */
export interface PermissionSubject {
    role?: UserRole | string | null;
    permissions?: string[] | null;
    /** 29 Sep 2026: role defaults a super admin has switched off for this one person. */
    deniedPermissions?: string[] | null;
}

/**
 * What happens when a super admin switches a feature off for someone (29 Sep 2026).
 * Shown as a warning before the change; nothing is blocked.
 */
export const REMOVE_WARNING: Record<PermissionKey, string> = {
    students: "They will no longer see or edit student records in the portal, and the app will hide students' private details (date of birth, GP, nationality, ethnicity, refugee number). Marking attendance still works.",
    courses: "They will no longer be able to create or edit courses, or assign teachers and students to courses. The Courses page disappears from their portal. They can still teach and mark their own registers.",
    class_reports: "The Class Reports page disappears from their portal.",
    calendar: "The shared class calendar disappears from their portal.",
    ghana_ops: "The Ghana Operations dashboard disappears from their portal.",
    statistics: "The Statistics page and its report builder (the old Funders Report) disappear from their portal.",
    volunteers: "They will no longer see or edit volunteer records, approve volunteer hours or open volunteer details. The Volunteers page disappears from their portal.",
    badges: "They will no longer create, edit or award badges.",
    volunteer_applications: "They will no longer see volunteer applications or CVs, book interviews or send recruitment emails.",
    student_applications: "They will no longer see or process student applications.",
    announcements: "They will no longer publish or edit announcements.",
    social_media: "The Social Media dashboard and content plan disappear from their portal.",
    grants: "They will no longer see the grant finder or the funding reports.",
    inventory: "They will no longer see the laptop and equipment inventory, including laptop PINs.",
    leave_manage: "They will no longer approve or reject other people's leave.",
    app_admin: "In the mobile app they go back to the normal teacher screens and lose the admin menu (managing courses, teachers, volunteers and students).",
};

/**
 * Does this person have this capability?
 * super_admin always true. Otherwise: role default OR explicit grant.
 */
export function can(user: PermissionSubject | null | undefined, key: PermissionKey): boolean {
    if (!user) return false;
    if (user.role === 'super_admin') return true;

    const granted = Array.isArray(user.permissions) ? user.permissions : [];
    if (granted.includes(key)) return true;

    const denied = Array.isArray(user.deniedPermissions) ? user.deniedPermissions : [];
    if (denied.includes(key)) return false;

    const defaults = ROLE_DEFAULTS[user.role as UserRole];
    return Array.isArray(defaults) && defaults.includes(key);
}

/** True if the user has at least one of the keys. Used for section headers in the sidebar. */
export function canAny(user: PermissionSubject | null | undefined, keys: PermissionKey[]): boolean {
    return keys.some(k => can(user, k));
}

/** Everything this person can currently do, defaults plus explicit grants. */
export function effectivePermissions(user: PermissionSubject | null | undefined): PermissionKey[] {
    if (!user) return [];
    return ALL_PERMISSIONS.filter(k => can(user, k));
}

/** Keys granted explicitly on the user doc, over and above the role default. */
export function extraPermissions(user: PermissionSubject | null | undefined): PermissionKey[] {
    if (!user) return [];
    const defaults = ROLE_DEFAULTS[user.role as UserRole] || [];
    const granted = Array.isArray(user.permissions) ? user.permissions : [];
    return ALL_PERMISSIONS.filter(k => granted.includes(k) && !defaults.includes(k));
}
