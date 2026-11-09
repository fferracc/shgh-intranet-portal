import { httpsCallable } from 'firebase/functions';
import { functions } from '@/lib/firebase';

/*
 * Ghana Operations data, read by the portal SERVER (functions/ghana.js, `ghanaOverview`).
 *
 * The browser no longer signs in to the Ghana Firebase project at all. The callable checks
 * that the caller holds the Ghana Operations permission (ghana_ops), reads the Ghana app's
 * published `portalPublic` snapshot with the server's own credentials, and returns only
 * what this page needs.
 */

export type GhanaDay = {
    p: string[];   // present, on time
    l: string[];   // late
    a: string[];   // absent (recorded by app v2 only)
    t: string[];   // teachers marked in
    v: boolean;    // taken by app v2, so p + l + a is the whole register
};

export type GhanaClass = {
    id: string;
    code: string;
    name: string;
    enrolled: number;
    roster: string[];
    teacherIds: string[];
    names: Record<string, string>;
    days: Record<string, GhanaDay>;
    updatedAt: string | null;
};

export type GhanaOverview = {
    source: 'snapshot';
    empty: boolean;
    updatedAt: string | null;          // latest publish anywhere in the snapshot
    summaryUpdatedAt: string | null;
    summary: { totalStudents: number; enrolledStudents: number; teacherCount: number };
    classes: GhanaClass[];
};

export type GhanaErrorKind =
    | 'not_granted'      // the Ghana project has not given the portal server read access yet
    | 'no_permission'    // this portal user lacks ghana_ops
    | 'signed_out'
    | 'other';

export class GhanaOverviewError extends Error {
    kind: GhanaErrorKind;
    constructor(kind: GhanaErrorKind, message: string) {
        super(message);
        this.kind = kind;
        this.name = 'GhanaOverviewError';
    }
}

const callable = httpsCallable<{ source: 'snapshot' }, GhanaOverview>(functions, 'ghanaOverview');

/** The client SDK reports codes as "functions/<code>"; accept either form. */
const codeOf = (e: unknown): string => {
    const raw = e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : '';
    return raw.startsWith('functions/') ? raw.slice('functions/'.length) : raw;
};

const reasonOf = (e: unknown): string => {
    const details = e && typeof e === 'object' && 'details' in e ? (e as { details: unknown }).details : null;
    return details && typeof details === 'object' && 'reason' in details
        ? String((details as { reason: unknown }).reason)
        : '';
};

export async function fetchGhanaOverview(): Promise<GhanaOverview> {
    try {
        const res = await callable({ source: 'snapshot' });
        return res.data;
    } catch (e) {
        const code = codeOf(e);
        const message = e instanceof Error ? e.message : String(e);
        if (code === 'failed-precondition' && reasonOf(e) === 'ghana_access_not_granted') {
            throw new GhanaOverviewError('not_granted', message);
        }
        if (code === 'permission-denied') {
            throw new GhanaOverviewError('no_permission', 'Your portal account does not have the Ghana Operations permission.');
        }
        if (code === 'unauthenticated') {
            throw new GhanaOverviewError('signed_out', 'Please sign in to the portal again.');
        }
        throw new GhanaOverviewError('other', message || 'Could not read the Ghana statistics.');
    }
}

/** Whole days since an ISO timestamp, or null when it is missing or unreadable. */
export function daysSince(iso: string | null | undefined, now: Date = new Date()): number | null {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    if (isNaN(t)) return null;
    return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}
