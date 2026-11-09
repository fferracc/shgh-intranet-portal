// Saved report templates (reportTemplates collection). A template keeps the ticks, the title,
// the period RULE (for example "last financial year", worked out again on the day it is used),
// the filters and the "Include names" choice. Shared by everyone who can open Statistics.
import { addDoc, collection, deleteDoc, doc, getDocs, serverTimestamp, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { CourseStatusFilter, CourseTypeFilter, ReportSelection } from "./model";
import type { PeriodRule } from "./periods";

export interface TemplateSelection extends ReportSelection {
    includeNames: boolean;
    title: string;
    subtitle: string;
    notes: string;
    periodRule: PeriodRule;
    customFrom?: string;
    customTo?: string;
    typeFilter: CourseTypeFilter;
    statusFilter: CourseStatusFilter;
}

export interface ReportTemplate {
    id: string;
    name: string;
    selection: TemplateSelection;
    createdBy?: string;
    createdAtMs: number;
    updatedAtMs: number;
}

const COL = "reportTemplates";
const toMs = (v: any) => (v && typeof v.toMillis === "function" ? v.toMillis() : typeof v?.seconds === "number" ? v.seconds * 1000 : 0);
/** Firestore refuses undefined values. */
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

export async function listTemplates(): Promise<ReportTemplate[]> {
    const snap = await getDocs(collection(db, COL));
    return snap.docs.map(d => {
        const x = d.data();
        return { id: d.id, name: String(x.name || "Untitled"), selection: x.selection as TemplateSelection, createdBy: x.createdBy, createdAtMs: toMs(x.createdAt), updatedAtMs: toMs(x.updatedAt) };
    }).sort((a, b) => a.name.localeCompare(b.name, "en-GB"));
}

export async function saveTemplate(name: string, selection: TemplateSelection, uid: string): Promise<string> {
    const ref = await addDoc(collection(db, COL), { name: name.trim().slice(0, 120), selection: plain(selection), createdBy: uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    return ref.id;
}

export async function updateTemplate(id: string, changes: { name?: string; selection?: TemplateSelection }): Promise<void> {
    const data: Record<string, unknown> = { updatedAt: serverTimestamp() };
    if (changes.name !== undefined) data.name = changes.name.trim().slice(0, 120);
    if (changes.selection) data.selection = plain(changes.selection);
    await updateDoc(doc(db, COL, id), data);
}

export async function deleteTemplate(id: string): Promise<void> {
    await deleteDoc(doc(db, COL, id));
}
