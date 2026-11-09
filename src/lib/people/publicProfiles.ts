/**
 * Public directory (1 Oct 2026).
 *
 * publicProfiles/{uid} = { name, displayName, photo, role, archived, updatedAt }, written ONLY
 * by the server (functions/people.js, publicProfileMirror) whenever users/{uid} changes.
 * Volunteers in the app read this instead of users, so they see who is who without
 * emails, phones or personal fields. Every signed-in account can read it.
 */

import { httpsCallable } from "firebase/functions";
import { functions } from "@/lib/firebase";

export interface PublicProfile {
    uid: string;
    name: string;
    displayName: string;
    photo: string;
    role: string;
    archived: boolean;
}

/** Super admin only: fills publicProfiles for everyone and removes leftovers. */
export async function rebuildPublicProfiles(): Promise<{ written: number; removed: number }> {
    const call = httpsCallable(functions, "rebuildPublicProfiles");
    const res = await call({});
    return res.data as { written: number; removed: number };
}
