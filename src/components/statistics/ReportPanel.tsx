"use client";

import { useEffect, useState } from "react";
import { FileSpreadsheet, FileText, FolderOpen, Pencil, Printer, Save, Sparkles, Trash2, X } from "lucide-react";
import { deleteTemplate, listTemplates, saveTemplate, updateTemplate, type ReportTemplate, type TemplateSelection } from "@/lib/statistics/templates";
import { periodLabel } from "@/lib/statistics/periods";

export interface ReportFields { title: string; subtitle: string; notes: string; includeNames: boolean }

export function ReportPanel({ fields, setFields, sectionCount, kpiCount, tableCount, onPrint, onExcel, onWord, onPrompt, onAiSummary, busy, current, apply, uid }: {
    fields: ReportFields;
    setFields: (f: ReportFields) => void;
    sectionCount: number;
    kpiCount: number;
    tableCount: number;
    onPrint: () => void;
    onExcel: () => void;
    onWord: () => void;
    onPrompt: () => void;
    onAiSummary?: () => void;
    busy: string;
    current: () => TemplateSelection;
    apply: (t: TemplateSelection) => void;
    uid: string;
}) {
    const [templates, setTemplates] = useState<ReportTemplate[] | null>(null);
    const [tplError, setTplError] = useState("");
    const [newName, setNewName] = useState("");
    const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
    const [loadedId, setLoadedId] = useState("");
    const [message, setMessage] = useState("");

    const refresh = async () => {
        try {
            setTemplates(await listTemplates());
            setTplError("");
        } catch (e) {
            console.warn("Report templates could not be read", e);
            setTemplates([]);
            setTplError("Saved templates could not be read. The reportTemplates rule may be missing.");
        }
    };
    useEffect(() => { refresh(); }, []);

    const flash = (m: string) => { setMessage(m); setTimeout(() => setMessage(""), 3000); };
    const save = async () => {
        const name = newName.trim();
        if (!name) return;
        try {
            const id = await saveTemplate(name, current(), uid);
            setNewName(""); setLoadedId(id); flash(`Saved "${name}".`);
            await refresh();
        } catch (e) { console.warn(e); flash("The template could not be saved."); }
    };
    const overwrite = async (t: ReportTemplate) => {
        if (!confirm(`Replace the saved choices of "${t.name}" with what is ticked now?`)) return;
        try { await updateTemplate(t.id, { selection: current() }); flash(`Updated "${t.name}".`); await refresh(); }
        catch (e) { console.warn(e); flash("The template could not be updated."); }
    };
    const rename = async () => {
        if (!renaming || !renaming.name.trim()) return;
        try { await updateTemplate(renaming.id, { name: renaming.name }); setRenaming(null); await refresh(); }
        catch (e) { console.warn(e); flash("The template could not be renamed."); }
    };
    const remove = async (t: ReportTemplate) => {
        if (!confirm(`Delete the template "${t.name}"?`)) return;
        try { await deleteTemplate(t.id); if (loadedId === t.id) setLoadedId(""); await refresh(); }
        catch (e) { console.warn(e); flash("The template could not be deleted."); }
    };
    const load = (t: ReportTemplate) => { apply(t.selection); setLoadedId(t.id); flash(`Loaded "${t.name}".`); };

    const btn = "inline-flex items-center gap-2 rounded-lg text-sm font-medium px-3 py-2 shadow-sm disabled:opacity-50";
    return (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
            <h2 className="text-lg font-bold text-slate-900">Build a report</h2>
            <p className="text-xs text-slate-500 mt-0.5">Tick &quot;Include in report&quot; on the sections, figures and tables you want below. Documents show totals only unless you tick Include names. Tables of students&apos; names never leave the screen.</p>

            <div className="grid gap-3 md:grid-cols-2 mt-4">
                <label className="text-sm text-slate-700">Report title
                    <input value={fields.title} onChange={e => setFields({ ...fields, title: e.target.value })} className="block w-full mt-1 p-2 border border-slate-300 rounded-md text-sm" placeholder="Impact report" />
                </label>
                <label className="text-sm text-slate-700">Subtitle (for example the funder)
                    <input value={fields.subtitle} onChange={e => setFields({ ...fields, subtitle: e.target.value })} className="block w-full mt-1 p-2 border border-slate-300 rounded-md text-sm" placeholder="For the Lottery Community Fund" />
                </label>
                <label className="text-sm text-slate-700 md:col-span-2">Notes (optional, printed under the title)
                    <textarea value={fields.notes} onChange={e => setFields({ ...fields, notes: e.target.value })} rows={2} className="block w-full mt-1 p-2 border border-slate-300 rounded-md text-sm" />
                </label>
            </div>
            <label className="mt-3 flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                <input type="checkbox" checked={fields.includeNames} onChange={e => setFields({ ...fields, includeNames: e.target.checked })} className="h-4 w-4 rounded accent-[#2c4a00]" />
                Include names (volunteers, staff and recipients). Off: totals only.
            </label>

            <p className="mt-3 text-xs text-slate-600">In the report now: <strong>{sectionCount}</strong> section{sectionCount === 1 ? "" : "s"}, <strong>{kpiCount}</strong> figure{kpiCount === 1 ? "" : "s"}, <strong>{tableCount}</strong> table{tableCount === 1 ? "" : "s"}.</p>

            <div className="flex flex-wrap gap-2 mt-3">
                <button onClick={onPrint} disabled={!!busy} className={`${btn} bg-slate-900 text-white hover:bg-slate-800`}><Printer size={16} /> Print or save as PDF</button>
                <button onClick={onExcel} disabled={!!busy} className={`${btn} bg-[#2c4a00] text-white hover:opacity-90`}><FileSpreadsheet size={16} /> {busy === "excel" ? "Making Excel…" : "Excel"}</button>
                <button onClick={onWord} disabled={!!busy} className={`${btn} bg-[#7f4c12] text-white hover:opacity-90`}><FileText size={16} /> {busy === "word" ? "Making Word…" : "Word"}</button>
                <button onClick={onPrompt} disabled={!!busy} className={`${btn} bg-white border border-slate-300 text-slate-700 hover:bg-slate-50`} title="Copies the ticked figures (numbers only, no names) to paste into an AI assistant"><Sparkles size={16} /> Copy AI summary prompt</button>
                {onAiSummary && <button onClick={onAiSummary} disabled={!!busy} className={`${btn} bg-white border border-[#2c4a00] text-[#2c4a00] hover:bg-green-50`} title="The AI writes a short summary from the ticked figures only (no names)"><Sparkles size={16} /> {busy === "ai" ? "Writing…" : "Write AI summary"}</button>}
            </div>

            <div className="mt-5 border-t border-slate-100 pt-4">
                <h3 className="font-semibold text-sm text-slate-800 flex items-center gap-2"><FolderOpen size={16} /> Saved report templates</h3>
                <p className="text-xs text-slate-500">A template keeps the ticks, title, period rule (for example Last financial year), filters and Include names.</p>
                {tplError && <p className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">{tplError}</p>}
                <div className="flex flex-wrap gap-2 mt-2">
                    <input value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") save(); }} placeholder="Template name" className="p-2 border border-slate-300 rounded-md text-sm flex-1 min-w-[12rem]" />
                    <button onClick={save} disabled={!newName.trim()} className={`${btn} bg-white border border-slate-300 text-slate-700 hover:bg-slate-50`}><Save size={16} /> Save as new template</button>
                </div>
                {message && <p className="mt-2 text-xs text-green-700">{message}</p>}
                {templates === null ? <p className="text-xs text-slate-400 mt-2">Loading templates…</p> : templates.length === 0 ? <p className="text-xs text-slate-400 mt-2 italic">No saved templates yet.</p> : (
                    <ul className="mt-2 divide-y divide-slate-100 border border-slate-100 rounded-lg">
                        {templates.map(t => (
                            <li key={t.id} className={`flex flex-wrap items-center gap-2 px-3 py-2 text-sm ${loadedId === t.id ? "bg-[#2c4a00]/5" : ""}`}>
                                {renaming?.id === t.id ? (
                                    <>
                                        <input value={renaming.name} onChange={e => setRenaming({ id: t.id, name: e.target.value })} onKeyDown={e => { if (e.key === "Enter") rename(); }} className="p-1 border border-slate-300 rounded text-sm flex-1" autoFocus />
                                        <button onClick={rename} className="text-xs font-medium text-[#2c4a00]">Save</button>
                                        <button onClick={() => setRenaming(null)} className="text-slate-400" aria-label="Cancel"><X size={14} /></button>
                                    </>
                                ) : (
                                    <>
                                        <span className="font-medium text-slate-800 flex-1 min-w-0 truncate">{t.name}</span>
                                        <span className="text-xs text-slate-400">{periodLabel(t.selection?.periodRule || "all")}</span>
                                        <button onClick={() => load(t)} className="text-xs font-semibold px-2 py-1 rounded bg-[#2c4a00] text-white">Load</button>
                                        <button onClick={() => overwrite(t)} className="text-xs px-2 py-1 rounded border border-slate-300 text-slate-600 hover:bg-slate-50" title="Save what is ticked now into this template">Update</button>
                                        <button onClick={() => setRenaming({ id: t.id, name: t.name })} className="text-slate-500 hover:text-slate-800" aria-label="Rename"><Pencil size={14} /></button>
                                        <button onClick={() => remove(t)} className="text-red-500 hover:text-red-700" aria-label="Delete"><Trash2 size={14} /></button>
                                    </>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}
