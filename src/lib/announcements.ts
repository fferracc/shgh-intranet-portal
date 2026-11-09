// Announcements (30 Sep 2026, Franco's decisions). Shared rules for the portal admin page,
// the dashboard card (src/components/dashboard/AnnouncementsCard.tsx) and, mirrored by
// hand, the UK app (UK App/index.html, search "ANNOUNCEMENT RULES").
//
// announcements/{id}: { title, content, severity: 'info' | 'important' | 'urgent',
//   audience: 'staff' | 'volunteers' | 'everyone', expiresAt?: 'YYYY-MM-DD',
//   createdAt, createdBy, updatedAt, updatedBy }
// Old announcements have no audience (= everyone) and no expiry (= always live).
// expiresAt is the LAST day it is shown (UK date).
import { addDoc, collection, deleteDoc, doc, getDocs, limit, orderBy, query, serverTimestamp, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { londonToday } from "@/lib/registers";
import { audienceGroup, policyAudience, PolicyAudience } from "@/lib/policies";

export type AnnouncementSeverity = "info" | "important" | "urgent";
export type AnnouncementAudience = PolicyAudience;

export interface Announcement {
    id: string;
    title: string;
    content: string;
    severity: AnnouncementSeverity;
    audience: AnnouncementAudience;
    expiresAt?: string;
    /** 'YYYY-MM-DD' in UK time. */
    createdDay?: string;
    createdMs: number;
    createdBy?: string;
    updatedDay?: string;
}

export const SEVERITY_OPTIONS: { value: AnnouncementSeverity; label: string }[] = [
    { value: "info", label: "Information" },
    { value: "important", label: "Important" },
    { value: "urgent", label: "Urgent" },
];

/** Colours per severity. Tailwind classes for the portal, plain hex for the app. */
export const SEVERITY_STYLE: Record<AnnouncementSeverity, { label: string; card: string; title: string; text: string; badge: string; dot: string; hex: { bg: string; border: string; text: string } }> = {
    info: {
        label: "Information",
        card: "bg-blue-50 border-blue-100 hover:border-blue-300",
        title: "text-blue-900",
        text: "text-blue-800",
        badge: "bg-blue-100 text-blue-700",
        dot: "bg-blue-500",
        hex: { bg: "#eff6ff", border: "#3b82f6", text: "#1e3a8a" },
    },
    important: {
        label: "Important",
        card: "bg-amber-50 border-amber-200 hover:border-amber-400",
        title: "text-amber-900",
        text: "text-amber-800",
        badge: "bg-amber-100 text-amber-800",
        dot: "bg-amber-500",
        hex: { bg: "#fffbeb", border: "#f59e0b", text: "#78350f" },
    },
    urgent: {
        label: "Urgent",
        card: "bg-red-50 border-red-200 hover:border-red-400",
        title: "text-red-900",
        text: "text-red-800",
        badge: "bg-red-100 text-red-700",
        dot: "bg-red-500",
        hex: { bg: "#fef2f2", border: "#ef4444", text: "#7f1d1d" },
    },
};

export function announcementSeverity(a: { severity?: unknown } | null | undefined): AnnouncementSeverity {
    const s = String(a?.severity ?? "").trim().toLowerCase();
    return s === "important" || s === "urgent" ? s : "info";
}

export function announcementAudience(a: { audience?: unknown } | null | undefined): AnnouncementAudience {
    return policyAudience(a);
}

const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Live = no expiry, or today (UK) is on or before the expiry day. */
export function isLive(a: { expiresAt?: unknown }, today: string = londonToday()): boolean {
    return !isDay(a.expiresAt) || today <= a.expiresAt;
}

/**
 * Can someone with this role see it? Staff, admins and the super admin see 'staff' and
 * 'everyone'; volunteers see 'volunteers' and 'everyone'; anyone else sees 'everyone' only.
 */
export function visibleTo(a: { audience?: unknown }, role: unknown): boolean {
    const aud = announcementAudience(a);
    if (aud === "everyone") return true;
    return audienceGroup(role) === aud;
}

function toMs(v: any): number {
    if (!v) return 0;
    if (typeof v.toMillis === "function") return v.toMillis();
    if (typeof v.seconds === "number") return v.seconds * 1000;
    const t = new Date(v).getTime();
    return isNaN(t) ? 0 : t;
}

export function toAnnouncement(id: string, d: any): Announcement {
    const createdMs = toMs(d?.createdAt);
    const updatedMs = toMs(d?.updatedAt);
    return {
        id,
        title: String(d?.title || ""),
        content: String(d?.content || ""),
        severity: announcementSeverity(d),
        audience: announcementAudience(d),
        expiresAt: isDay(d?.expiresAt) ? d.expiresAt : undefined,
        createdDay: createdMs ? londonToday(new Date(createdMs)) : undefined,
        createdMs,
        createdBy: d?.createdBy ? String(d.createdBy) : undefined,
        updatedDay: updatedMs ? londonToday(new Date(updatedMs)) : undefined,
    };
}

/** Newest first. `max` limits how many documents are read. */
export async function loadAnnouncements(max = 100): Promise<Announcement[]> {
    const snap = await getDocs(query(collection(db, "announcements"), orderBy("createdAt", "desc"), limit(max)));
    return snap.docs.map(s => toAnnouncement(s.id, s.data()));
}

/** The live announcements this role may see, newest first. */
export async function loadLiveAnnouncementsFor(role: unknown): Promise<Announcement[]> {
    const today = londonToday();
    return (await loadAnnouncements(100)).filter(a => isLive(a, today) && visibleTo(a, role));
}

export interface AnnouncementInput {
    title: string;
    content: string;
    severity: AnnouncementSeverity;
    audience: AnnouncementAudience;
    /** '' or 'YYYY-MM-DD'. */
    expiresAt: string;
}

function clean(input: AnnouncementInput) {
    return {
        title: input.title.trim(),
        content: input.content.trim(),
        severity: input.severity,
        audience: input.audience,
        expiresAt: isDay(input.expiresAt) ? input.expiresAt : null,
    };
}

/** createdBy / updatedBy hold the person's name (as before); the uid is kept alongside. */
export interface Author { uid: string; name: string }

export async function createAnnouncement(input: AnnouncementInput, by: Author): Promise<void> {
    await addDoc(collection(db, "announcements"), {
        ...clean(input),
        createdAt: serverTimestamp(),
        createdBy: by.name,
        createdByUid: by.uid,
        updatedAt: serverTimestamp(),
        updatedBy: by.name,
        updatedByUid: by.uid,
    });
}

export async function updateAnnouncement(id: string, input: AnnouncementInput, by: Author): Promise<void> {
    await updateDoc(doc(db, "announcements", id), {
        ...clean(input),
        updatedAt: serverTimestamp(),
        updatedBy: by.name,
        updatedByUid: by.uid,
    });
}

export async function deleteAnnouncement(id: string): Promise<void> {
    await deleteDoc(doc(db, "announcements", id));
}

/** 'YYYY-MM-DD' to '30 Sep 2026'. */
export function shortUkDate(day?: string): string {
    if (!isDay(day)) return "";
    const [y, m, d] = day.split("-").map(Number);
    return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}
