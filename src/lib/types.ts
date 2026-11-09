export type UserRole = 'super_admin' | 'admin' | 'staff' | 'line_manager' | 'standard_user' | 'volunteer';

export interface UserProfile {
    /** 30 Sep 2026: archived instead of deleted (history kept). See src/lib/archive.ts. */
    archived?: boolean;
    uid: string;
    email: string;
    displayName: string;
    photoURL?: string;
    role: UserRole;
    /** Explicit feature grants on top of the role default. Super admin only may write this. */
    permissions?: string[];
    department?: string;
    managerId?: string; // UID of the Line Manager
    /** Absent for volunteers: they have no annual leave (decided 24 Sep 2026). */
    leaveAllowance?: {
        total: number; // Total days this leave year (entitlement + carry-over)
        remaining: number;
        year: number; // Current leave year (e.g. 2025)
        /** This person's own yearly entitlement, set when their role is given leave.
         *  The yearly reset uses it; people without it fall back to BASE_ALLOWANCE (20). */
        entitlement?: number;
    };
}

export type LeaveType = 'annual' | 'sick' | 'toil' | 'unpaid';
export type LeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface LeaveRequest {
    id: string;
    userId: string;
    userName: string;
    managerId?: string; // Denormalized for easier querying
    type: LeaveType;
    startDate: string; // ISO Date string
    endDate: string; // ISO Date string
    totalDays: number;
    reason?: string;
    status: LeaveStatus;
    createdAt: string; // ISO Date string
    approvedAt?: string;
    approvedBy?: string;
    rejectionReason?: string;
}

export interface Policy {
    id: string;
    title: string;
    url: string; // Google Drive Link
    version: string;
    driveId?: string;
    createdAt: string;
}

export interface PolicyReadRecord {
    userId: string;
    policyId: string;
    readAt: string;
    version: string;
}

export interface VolunteerApplication {
    id: string;
    fullName: string;
    email: string;
    phone: string;
    cvUrl?: string; // Link to file
    capabilities: string[]; // e.g. ["Coding", "Design"]
    status: 'new' | 'interview' | 'accepted' | 'rejected';
    appliedAt: string;
    interviewDate?: string;
    notes?: string;
}

// --- NEW INTERFACES FROM APP ---

export interface Student {
    /** 30 Sep 2026: archived instead of deleted (history kept). See src/lib/archive.ts. */
    archived?: boolean;
    id: string;
    name: string;
    age: number;
    email?: string;
    ethnicity?: string;
    nationality?: string;
    postcode?: string;
    reason?: string;
    parentName?: string;
    parentPhone?: string;
    emergencyContact?: string;
    gpName?: string;
    allergies?: string;
    photoConsent?: boolean;
    createdAt: string;
    // Fields from application acceptance
    dob?: string;
    mobile?: string;
    itLevel?: string;
    languageUsed?: string;
    applicationId?: string;
    refugeeNumber?: string;
    sovereignReference?: string;
    [key: string]: any;
}

export interface Course {
    id: string;
    code: string;
    name: string;
    description?: string;
    schedule: {
        day: string;
        start: string;
        end: string;
        frequency?: 'Weekly' | 'Bi-weekly' | 'Monthly' | 'Custom';
        customNotes?: string;
    };
    startDate: string;
    endDate: string;
    setting: string; // "Virtual" | "In-Person"
    venue?: string;
    address?: string;
    postcode?: string;
    status: 'Running' | 'Planned' | 'Completed' | 'Cancelled';
    type?: 'Rolling' | 'Drop-in' | '1-2-1';
    createdAt?: string;
    volunteers?: { id: string; name: string }[];
}

/** How a badge is earned (see src/lib/badges.ts). "Manual" or no type: by hand only. */
export type BadgeType = "classCount" | "hours" | "monthsOfService" | "coursesTaught" | "Manual";

export interface Badge {
    /** 30 Sep 2026: archived instead of deleted (history kept). See src/lib/archive.ts. */
    archived?: boolean;
    id: string;
    name: string;
    description: string;
    iconUrl: string;
    category?: string; // e.g., "Attendance", "Skill", "Community"
    /** Missing on old portal badges: by hand only. */
    type?: BadgeType | string;
    /** The target for an automatic badge (classes, hours, months or courses). */
    goal?: number | null;
}

/** earnedAchievements/{uid}_{badgeId} (older documents may have a random id). Never changed once written. */
export interface EarnedBadge {
    id: string;
    badgeId: string;
    volunteerId: string;
    earnedAt: any;           // Firestore Timestamp
    /** 'YYYY-MM-DD' the target was reached (or the day of a hand award). Missing on older awards. */
    reachedOn?: string;
    /** The figure when the badge was reached (classes, hours, months or courses). */
    value?: number;
    /** 'auto' for the server, else the uid of the person who awarded it (older awards: a source name or nothing). */
    awardedBy?: string;
    awardedByName?: string;
    /** true only for hand awards made through awardBadgeByHand. Only these can be withdrawn. */
    manual?: boolean;
    reason?: string;
    trigger?: string;
}

export interface ApplicationProcess {
    id: string;
    title: string;
    description: string;
    status: "Open" | "Closed";
    courseId?: string; // Linked course ID
    sourceProject: "refugees-appform" | "main";
    collectionName: string;
    externalLink?: string;
    /** Set when the applicants fill in a form hosted by the portal itself (/apply?p=<id>). */
    formType?: "children" | "adults" | "refugees" | "referral";
    createdAt?: string;
    /** 6 Oct 2026 (see src/lib/studentApplications.ts): optional UK dates "YYYY-MM-DD". */
    opensOn?: string;
    closesOn?: string;
    /** The end of closesOn (23:59:59 UK time); the database refuses answers after it. */
    closesAt?: unknown;
    /** Archived instead of deleted (super admin only). Its applications stay readable. */
    archived?: boolean;
    archivedAt?: string;
    archivedBy?: string;
    archivedByName?: string;
    /** Set on a process moved from the old refugees-appform database. */
    movedFrom?: { project: string; collection: string; count: number; at: string; by: string };
}

export interface ApplicationFormLink {
    id: string;
    course: string;
    link: string;
    startDate: string;
    endDate: string;
    courseFor: 'Children' | 'Adults +50' | 'Refugees';
    status: 'Open' | 'Closed';
    createdAt: string;
}

// --- Social Media Studio ---

export type SocialNetwork =
    | 'facebook'
    | 'instagram'
    | 'threads'
    | 'linkedin'
    | 'youtube'
    | 'tiktok';

// Mirrors the states the n8n publishers write back. 'refused' and
// 'blockedSafeguarding' are the two governance gates refusing to publish —
// they are working as designed, not errors to be cleared.
export type SocialPostStatus =
    | 'draft'
    | 'approved'
    | 'published'
    | 'rejected'
    | 'refused'
    | 'blockedSafeguarding'
    | 'failed'
    | 'removed';

export interface SocialPost {
    id: string;
    briefId?: string;
    network: SocialNetwork;
    copy: string;
    mediaUrl?: string;
    mediaType?: 'none' | 'image' | 'video';
    // 6 Oct 2026: 'heygen' when mediaUrl is a HeyGen video link; n8n fetches the file at publish time.
    mediaSource?: 'heygen' | 'url' | '';
    heygenVideoId?: string;
    scheduledFor?: string | null;
    status: SocialPostStatus;

    // Safeguarding. containsPerson defaults true whenever media is attached,
    // so the safe answer needs no thought and the unsafe one is deliberate.
    containsPerson: boolean;
    personConsentByUid?: string;
    personConsentByName?: string;
    consentNote?: string;

    // Approval identity comes from the signed-in session, never a typed name.
    approvedByUid?: string;
    approvedByName?: string;
    approvedAt?: string;

    // Written back by n8n after publishing.
    postId?: string;
    permalinkUrl?: string;
    publishedAt?: string;
    lastError?: string;

    // Set by the portal's 'Publish now' button. n8n clears it after publishing.
    publishNow?: boolean;

    // Takedown is a two-stage thing on purpose. The portal records the request
    // and who made it; n8n does the actual removal and only then sets
    // status='removed'. So the portal never claims a post is gone before it is.
    takedownRequested?: boolean;
    takedownByUid?: string;
    takedownByName?: string;
    takedownRequestedAt?: string;
    takedownReason?: string;
    removedAt?: string;

    createdByUid?: string;
    createdByName?: string;
    createdAt?: string;
    updatedAt?: string;
}

export interface SocialBrief {
    id: string;
    topic: string;
    tone?: string;
    networks: SocialNetwork[];
    mediaMode: 'none' | 'library' | 'upload' | 'heygen';
    mediaUrl?: string;
    heygenPrompt?: string;
    scheduledFor?: string | null;
    containsPerson: boolean;
    status: 'new' | 'generating' | 'done' | 'failed';
    error?: string;
    createdByUid: string;
    createdByName: string;
    createdAt: string;
}

// --- Annual plan ---
//
// The plan is not a one-off generator. It is persistent context that every
// generation reads, which is the difference between a tool that gets ignored by
// February and one that keeps improving what the studio writes.

export interface StrategyAudience {
    name: string;
    notes?: string;
}

export interface StrategyTheme {
    name: string;
    sharePercent: number;
    networks: SocialNetwork[];
}

export interface StrategyAnchor {
    date: string;        // ISO date, or a plain month like '2026-09' for a season
    label: string;
    type?: 'season' | 'deadline' | 'awareness' | 'term' | 'other';
    notes?: string;
}

export interface SocialStrategy {
    id: string;          // the year, as a string
    year: number;
    purpose: string;

    // Order is the ranking. 'Funders first' produces markedly different copy
    // from 'learners first', so the list order is load-bearing, not cosmetic.
    audiences: StrategyAudience[];

    successMeasures: string[];

    // Hard exclusions. These go into the generation prompt as constraints, so
    // this is where the safeguarding rules reach the drafting stage rather than
    // only the publishing gate.
    neverPost: string[];

    themes: StrategyTheme[];
    cadence: Partial<Record<SocialNetwork, number>>;   // posts per week
    anchors: StrategyAnchor[];
    quarterFocus: { q1: string; q2: string; q3: string; q4: string };

    updatedByUid?: string;
    updatedByName?: string;
    updatedAt?: string;
}
