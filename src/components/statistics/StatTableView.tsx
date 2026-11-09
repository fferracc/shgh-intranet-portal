"use client";

import { useMemo, useState } from "react";
import { fmtCell, type Cell, type StatTable } from "@/lib/statistics/model";
import { Bars, MonthChart } from "./Charts";

const SHOW = 12;

export const rowMatches = (row: Cell[], q: string) => !q || row.some(c => String(c ?? "").toLowerCase().includes(q));

export function StatTableView({ table, search, included, onToggle, includeNames, sectionOn }: {
    table: StatTable;
    search: string;
    included: boolean;
    onToggle: (v: boolean) => void;
    includeNames: boolean;
    sectionOn: boolean;
}) {
    const [all, setAll] = useState(false);
    const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
    const q = search.trim().toLowerCase();
    const rows = useMemo(() => {
        const list = table.rows.filter(r => rowMatches(r, q) || table.title.toLowerCase().includes(q));
        if (!sort) return list;
        return [...list].sort((a, b) => {
            const x = a[sort.col], y = b[sort.col];
            if (x === null && y !== null) return 1;
            if (y === null && x !== null) return -1;
            if (typeof x === "number" && typeof y === "number") return (x - y) * sort.dir;
            return String(x ?? "").localeCompare(String(y ?? ""), "en-GB", { numeric: true }) * sort.dir;
        });
    }, [table, q, sort]);
    const shown = all ? rows : rows.slice(0, SHOW);
    const numeric = useMemo(() => table.columns.map((_, i) => i > 0 && table.rows.some(r => typeof r[i] === "number") && table.rows.every(r => r[i] === null || typeof r[i] === "number")), [table]);
    const blocked = table.screenOnly ? "Screen only" : table.names && !includeNames ? "Has names: tick Include names to add it" : "";

    return (
        <div className="mt-5">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                <h4 className="font-semibold text-slate-800 text-sm">{table.title}</h4>
                {blocked ? (
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200">{blocked}</span>
                ) : (
                    <label className={`flex items-center gap-1.5 text-xs cursor-pointer ${sectionOn ? "text-slate-600" : "text-slate-400"}`} title={sectionOn ? "" : "Tick the section to include it in the report"}>
                        <input type="checkbox" checked={included} onChange={e => onToggle(e.target.checked)} className="h-3.5 w-3.5 rounded border-slate-300 accent-[#2c4a00]" />
                        Include in report
                    </label>
                )}
            </div>
            {table.note && <p className="text-xs text-slate-500 mb-1">{table.note}</p>}
            {table.rows.length === 0 ? (
                <p className="text-xs text-slate-400 italic py-2">Nothing to show for this period.</p>
            ) : (
                <>
                    {table.chart && !q && (table.chart.months ? <MonthChart table={table} /> : <Bars table={table} />)}
                    <div className="overflow-x-auto border border-slate-100 rounded-lg">
                        <table className="w-full text-sm text-left border-collapse">
                            <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500 font-semibold">
                                <tr>
                                    {table.columns.map((c, i) => (
                                        <th key={i} className={`px-3 py-2 cursor-pointer hover:bg-slate-100 whitespace-nowrap ${numeric[i] ? "text-right" : ""}`}
                                            onClick={() => setSort(s => (s && s.col === i ? { col: i, dir: s.dir === 1 ? -1 : 1 } : { col: i, dir: i === 0 ? 1 : -1 }))}>
                                            {c}{sort?.col === i ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {shown.map((r, i) => (
                                    <tr key={i} className="hover:bg-slate-50">
                                        {r.map((c, j) => (
                                            <td key={j} className={`px-3 py-1.5 ${j === 0 ? "font-medium text-slate-800" : numeric[j] ? "text-right text-slate-600" : "text-slate-600"} ${c === null ? "text-slate-400" : ""}`}>{fmtCell(c)}</td>
                                        ))}
                                    </tr>
                                ))}
                                {shown.length === 0 && <tr><td colSpan={table.columns.length} className="px-3 py-2 text-xs text-slate-400 italic">No rows match the search.</td></tr>}
                            </tbody>
                        </table>
                    </div>
                    {rows.length > SHOW && (
                        <button onClick={() => setAll(v => !v)} className="mt-1 text-xs font-medium text-[#7f4c12] hover:underline">
                            {all ? "Show fewer" : `Show all ${rows.length} rows`}
                        </button>
                    )}
                </>
            )}
        </div>
    );
}
