"use client";

// The printed report (Print / PDF). Hidden on screen; the browser's print dialog saves it as a PDF.
import { fmtCell } from "@/lib/statistics/model";
import type { DocSection, ReportMeta } from "@/lib/statistics/report";
import { Bars } from "./Charts";

export function PrintReport({ docs, meta }: { docs: DocSection[]; meta: ReportMeta }) {
    const allKpis = docs.flatMap(s => s.kpis);
    return (
        <div className="hidden print:block text-slate-900 statistics-print">
            <style dangerouslySetInnerHTML={{
                __html: `
                @media print {
                    @page { size: A4; margin: 12mm; }
                    html, body { height: auto !important; overflow: visible !important; background: #fff !important; }
                    main > .absolute.pointer-events-none { display: none !important; }
                    .statistics-print table { page-break-inside: auto; }
                    .statistics-print tr { page-break-inside: avoid; }
                    .statistics-print h2 { page-break-after: avoid; }
                    .statistics-print * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
                }
            `}} />
            <header className="flex items-center gap-5 border-b-4 border-[#2c4a00] pb-4 mb-6">
                <img src="/assets/logo.png" alt="Sovereign House GH" className="h-20 w-20 object-contain" />
                <div>
                    <h1 className="text-3xl font-bold text-[#2c4a00]">{meta.title || "Statistics"}</h1>
                    {meta.subtitle && <p className="text-lg text-slate-700">{meta.subtitle}</p>}
                    <p className="text-sm text-slate-600 mt-1">Reporting period: <strong>{meta.periodText}</strong>. {meta.filtersText}.</p>
                    <p className="text-xs text-slate-500">Sovereign House GH, produced on {meta.generated}</p>
                </div>
            </header>
            {meta.notes && <p className="mb-6 text-sm whitespace-pre-line">{meta.notes}</p>}

            {allKpis.length > 0 && (
                <div className="mb-6">
                    <h2 className="text-xl font-bold text-[#2c4a00] mb-3">Key figures</h2>
                    <div className="grid grid-cols-4 gap-2">
                        {allKpis.map(k => (
                            <div key={k.id} className="border border-slate-300 rounded p-2 break-inside-avoid">
                                <div className="text-[10px] text-slate-500 leading-tight">{k.label}{k.now ? " (now)" : ""}</div>
                                <div className="text-xl font-bold text-[#2c4a00]">{fmtCell(k.value)}</div>
                                {k.hint && <div className="text-[9px] text-slate-400 leading-tight">{k.hint}</div>}
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {docs.filter(s => s.tables.length > 0 || s.notes.length > 0).map(s => (
                <section key={s.id} className="mb-8">
                    <h2 className="text-xl font-bold text-[#2c4a00] border-b border-slate-300 pb-1">{s.number}. {s.title}</h2>
                    <p className="text-xs italic text-slate-500 mt-1">{s.definition}</p>
                    {s.notes.map((n, i) => <p key={i} className="text-xs text-[#7f4c12] mt-1">{n}</p>)}
                    {s.tables.map(t => (
                        <div key={t.id} className="mt-4">
                            <h3 className="font-semibold text-sm">{t.title}</h3>
                            {t.note && <p className="text-[10px] italic text-slate-500">{t.note}</p>}
                            {t.chart && <Bars table={t} limit={24} />}
                            <table className="w-full text-[10px] border-collapse mt-1">
                                <thead>
                                    <tr>{t.columns.map((c, i) => <th key={i} className="border border-slate-300 bg-slate-100 px-1.5 py-1 text-left font-semibold">{c}</th>)}</tr>
                                </thead>
                                <tbody>
                                    {t.rows.map((r, i) => (
                                        <tr key={i}>{r.map((c, j) => <td key={j} className={`border border-slate-200 px-1.5 py-0.5 ${typeof c === "number" ? "text-right" : ""}`}>{fmtCell(c)}</td>)}</tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ))}
                </section>
            ))}
            {docs.length === 0 && <p className="text-sm">No section is ticked for the report.</p>}
        </div>
    );
}
