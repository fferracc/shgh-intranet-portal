// Grants in Firestore (1 Oct 2026): archive instead of delete, milestones and AI drafts on the
// grant document itself (grants rule: read, write adminOr('grants')), and the one-off move of
// milestones that used to live only in one browser's localStorage.
import { doc, runTransaction, updateDoc, writeBatch } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { toYmd } from "@/lib/grants/dates";

export interface Milestone {
    milestone: string;
    date: string; // 'YYYY-MM-DD'
    tasks: string[];
    completed: boolean;
}

export type AiDraftKind = "draft" | "summary" | "review" | "idea";
export interface AiDraft {
    text: string;
    kind: AiDraftKind;
    createdAt: string; // ISO
    createdBy: string;
    createdByName: string;
}

export interface Grant {
    id: string;
    index: number;
    grantName: string;
    funder: string;
    description: string;
    link: string;
    amount: number;
    amountRequested: number;
    status: string;
    grantProgress: string;
    deadline: string | null; // 'YYYY-MM-DD'
    parentId: string | null;
    archived?: boolean;
    archivedAt?: string;
    archivedBy?: string;
    archivedByName?: string;
    archivedWith?: string | null; // the main grant it was archived together with
    milestones?: Milestone[];
    aiDrafts?: AiDraft[];
}

export const GRANT_STATUSES = ["Draft", "Have to Apply", "Working on it", "Application Sent", "Granted", "Failed", "Not Applying"];

/** How many AI drafts are kept on one grant (the newest). Keeps the document well under 1 MB. */
export const AI_DRAFTS_KEPT = 25;
const AI_DRAFT_MAX_CHARS = 30000;

export function normaliseGrant(id: string, d: Record<string, unknown>): Grant {
    return {
        ...(d as unknown as Grant),
        id,
        grantName: String(d.grantName || ""),
        funder: String(d.funder || ""),
        description: String(d.description || ""),
        link: String(d.link || ""),
        status: String(d.status || "Have to Apply"),
        grantProgress: String(d.grantProgress || ""),
        amount: Number(d.amount) || 0,
        amountRequested: Number(d.amountRequested) || 0,
        index: Number(d.index) || 0,
        deadline: toYmd(d.deadline) || null,
        parentId: (d.parentId as string) || null,
        archived: d.archived === true,
        milestones: Array.isArray(d.milestones) ? (d.milestones as Milestone[]).map(cleanMilestone) : [],
        aiDrafts: Array.isArray(d.aiDrafts) ? (d.aiDrafts as AiDraft[]) : [],
    };
}

export function cleanMilestone(m: Partial<Milestone>): Milestone {
    return {
        milestone: String(m?.milestone || "Milestone").slice(0, 300),
        date: toYmd(m?.date) || "",
        tasks: Array.isArray(m?.tasks) ? m!.tasks.map(t => String(t || "").slice(0, 500)).slice(0, 50) : [],
        completed: m?.completed === true,
    };
}

type Who = { uid: string; name: string };

export async function saveMilestones(grantId: string, milestones: Milestone[], who: Who) {
    await updateDoc(doc(db, "grants", grantId), { milestones: milestones.map(cleanMilestone), milestonesUpdatedAt: new Date().toISOString(), milestonesUpdatedBy: who.uid });
}

/** Adds an AI draft to the grant, keeping the newest AI_DRAFTS_KEPT. Returns the new list. */
export async function addAiDraft(grantId: string, kind: AiDraftKind, text: string, who: Who): Promise<AiDraft[]> {
    const ref = doc(db, "grants", grantId);
    const entry: AiDraft = {
        text: String(text || "").slice(0, AI_DRAFT_MAX_CHARS), kind,
        createdAt: new Date().toISOString(), createdBy: who.uid, createdByName: who.name,
    };
    return runTransaction(db, async tx => {
        const s = await tx.get(ref);
        if (!s.exists()) throw new Error("This grant no longer exists.");
        const list = Array.isArray(s.data().aiDrafts) ? (s.data().aiDrafts as AiDraft[]) : [];
        const next = [...list, entry].slice(-AI_DRAFTS_KEPT);
        tx.update(ref, { aiDrafts: next });
        return next;
    });
}

/** Archive a main grant (never delete). Its sub-grants become standalone or are archived with it. */
export async function archiveGrant(grant: Grant, children: Grant[], mode: "standalone" | "archive", who: Who) {
    const at = new Date().toISOString();
    const batch = writeBatch(db);
    batch.update(doc(db, "grants", grant.id), { archived: true, archivedAt: at, archivedBy: who.uid, archivedByName: who.name, archivedWith: null });
    for (const c of children) {
        if (mode === "standalone") batch.update(doc(db, "grants", c.id), { parentId: null, detachedFrom: grant.id, detachedAt: at });
        else batch.update(doc(db, "grants", c.id), { archived: true, archivedAt: at, archivedBy: who.uid, archivedByName: who.name, archivedWith: grant.id });
    }
    await batch.commit();
}

/** Restore an archived grant, and the sub-grants that were archived together with it. */
export async function restoreGrant(grant: Grant, all: Grant[], who: Who) {
    const at = new Date().toISOString();
    const batch = writeBatch(db);
    const back = { archived: false, archivedWith: null, restoredAt: at, restoredBy: who.uid };
    batch.update(doc(db, "grants", grant.id), back);
    all.filter(g => g.archived && g.archivedWith === grant.id).forEach(c => batch.update(doc(db, "grants", c.id), back));
    await batch.commit();
}

// ---------------------------------------------------------------------------
// Milestones used to be kept only in the browser (localStorage 'grants_milestones_<id>').
// The first time someone opens the page in a browser, any found there are copied to the grant,
// but only when the grant has none yet. After that the browser copy is never read again.
// ---------------------------------------------------------------------------
const LEGACY_KEY = "grants_milestones_";
const MOVED_FLAG = "grants_milestones_moved_to_firestore";

function storage(): Storage | null {
    try { return typeof window !== "undefined" ? window.localStorage : null; } catch { return null; }
}

export async function moveBrowserMilestones(grants: Grant[], who: Who): Promise<number> {
    const ls = storage();
    if (!ls) return 0;
    try { if (ls.getItem(MOVED_FLAG)) return 0; } catch { return 0; }
    let moved = 0, failed = 0;
    for (const g of grants) {
        let list: Milestone[] = [];
        try {
            const raw = ls.getItem(LEGACY_KEY + g.id);
            const parsed = raw ? JSON.parse(raw) : [];
            list = Array.isArray(parsed) ? parsed.map(cleanMilestone) : [];
        } catch { list = []; }
        if (!list.length) continue;
        try {
            const ref = doc(db, "grants", g.id);
            const did = await runTransaction(db, async tx => {
                const s = await tx.get(ref);
                if (!s.exists()) return false;
                const cur = s.data().milestones;
                if (Array.isArray(cur) && cur.length) return false; // the grant already has its own
                tx.update(ref, { milestones: list, milestonesUpdatedAt: new Date().toISOString(), milestonesUpdatedBy: who.uid, milestonesMovedFromBrowser: true });
                return true;
            });
            if (did) moved++;
        } catch (e) { console.error("Milestones not moved for", g.id, e); failed++; }
    }
    if (!failed) { try { ls.setItem(MOVED_FLAG, new Date().toISOString()); } catch { /* storage blocked */ } }
    return moved;
}
