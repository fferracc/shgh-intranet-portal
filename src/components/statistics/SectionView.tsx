"use client";

import Link from "next/link";
import { AlertCircle, ExternalLink } from "lucide-react";
import { fmtCell, type ReportSelection, type StatSection } from "@/lib/statistics/model";
import { kpiOn, sectionOn, tableOn } from "@/lib/statistics/report";
import { StatTableView, rowMatches } from "./StatTableView";

/** Does anything in this section match the search? */
export function sectionMatches(s: StatSection, q: string): boolean {
    if (!q) return true;
    if (s.title.toLowerCase().includes(q) || s.definition.toLowerCase().includes(q)) return true;
    if (s.kpis.some(k => k.label.toLowerCase().includes(q))) return true;
    return s.tables.some(t => t.title.toLowerCase().includes(q) || t.rows.some(r => rowMatches(r, q)));
}

export function SectionView({ section, sel, setSel, search, includeNames }: {
    section: StatSection;
    sel: ReportSelection;
    setSel: (fn: (s: ReportSelection) => ReportSelection) => void;
    search: string;
    includeNames: boolean;
}) {
    const q = search.trim().toLowerCase();
    const on = sectionOn(sel, section.id);
    const toggle = (kind: keyof ReportSelection, id: string, v: boolean) => setSel(s => ({ ...s, [kind]: { ...s[kind], [id]: v } }));
    const tables = q ? section.tables.filter(t => t.title.toLowerCase().includes(q) || t.rows.some(r => rowMatches(r, q)) || section.title.toLowerCase().includes(q)) : section.tables;

    return (
        <section id={`stat-${section.id}`} className={`bg-white rounded-xl border shadow-sm p-5 scroll-mt-6 ${on ? "border-[#2c4a00]/40 ring-1 ring-[#2c4a00]/20" : "border-slate-200"}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <h2 className="text-lg font-bold text-slate-900">{section.number}. {section.title}</h2>
                    <p className="text-xs text-slate-500 mt-0.5 max-w-3xl">{section.definition}</p>
                </div>
                <label className={`flex items-center gap-2 text-sm font-medium px-3 py-1.5 rounded-lg border cursor-pointer ${on ? "bg-[#2c4a00] text-white border-[#2c4a00]" : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"}`}>
                    <input type="checkbox" checked={on} onChange={e => toggle("sections", section.id, e.target.checked)} className="h-4 w-4 rounded accent-[#7f4c12]" />
                    Include in report
                </label>
            </div>

            {section.unavailable && (
                <p className="mt-3 flex items-center gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2"><AlertCircle size={16} /> {section.unavailable}</p>
            )}
            {(section.notes || []).map((n, i) => (
                <p key={i} className="mt-2 text-xs text-[#7f4c12] bg-orange-50/60 border border-orange-100 rounded-md px-3 py-1.5">{n}</p>
            ))}
            {section.link && (
                <Link href={section.link.href} className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-white bg-[#7f4c12] hover:opacity-90 px-4 py-2 rounded-lg">
                    <ExternalLink size={16} /> {section.link.label}
                </Link>
            )}

            {section.kpis.length > 0 && (
                <div className="grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-5 mt-4">
                    {section.kpis.map(k => {
                        const kOn = kpiOn(sel, k.id);
                        return (
                            <div key={k.id} className={`relative rounded-lg border p-3 ${kOn && on ? "border-[#2c4a00]/30 bg-[#2c4a00]/[0.03]" : "border-slate-200 bg-white"}`}>
                                <label className="absolute top-2 right-2" title="Include in report">
                                    <input type="checkbox" checked={kOn} onChange={e => toggle("kpis", k.id, e.target.checked)} className="h-3.5 w-3.5 rounded border-slate-300 accent-[#2c4a00]" aria-label={`Include ${k.label} in report`} />
                                </label>
                                <div className="text-xs font-medium text-slate-500 pr-5">{k.label}{k.now && <span className="ml-1 text-[10px] uppercase tracking-wide bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">now</span>}</div>
                                <div className={`mt-1 font-bold ${section.id === "headline" ? "text-3xl" : "text-2xl"} ${k.value === null ? "text-slate-300" : "text-[#2c4a00]"}`}>{fmtCell(k.value)}</div>
                                {k.hint && <div className="text-[11px] text-slate-400 mt-0.5 leading-tight">{k.hint}</div>}
                            </div>
                        );
                    })}
                </div>
            )}

            {tables.map(t => (
                <StatTableView key={t.id} table={t} search={search} included={tableOn(sel, t.id)} onToggle={v => toggle("tables", t.id, v)} includeNames={includeNames} sectionOn={on} />
            ))}
        </section>
    );
}
