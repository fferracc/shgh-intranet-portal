"use client";

// Simple charts for the Statistics page: horizontal bars (Tailwind, print friendly) and a
// month chart (recharts, screen only).
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Cell, StatTable } from "@/lib/statistics/model";

const num = (c: Cell) => (typeof c === "number" ? c : Number.NaN);

export function chartPoints(t: StatTable): { label: string; value: number }[] {
    if (!t.chart) return [];
    return t.rows
        .map(r => ({ label: String(r[t.chart!.label] ?? ""), value: num(r[t.chart!.value]) }))
        .filter(p => Number.isFinite(p.value));
}

export function Bars({ table, limit = 15 }: { table: StatTable; limit?: number }) {
    const pts = chartPoints(table).slice(0, limit);
    if (pts.length === 0) return null;
    const percent = !!table.chart?.percent;
    const max = percent ? 100 : Math.max(1, ...pts.map(p => p.value));
    return (
        <div className="space-y-1.5 my-3" aria-hidden="true">
            {pts.map((p, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                    <div className="w-40 shrink-0 truncate text-slate-600" title={p.label}>{p.label}</div>
                    <div className="flex-1 bg-slate-100 rounded h-3.5 overflow-hidden print:border print:border-slate-300">
                        <div className="h-full rounded bg-[#2c4a00] print:bg-[#2c4a00]" style={{ width: `${Math.max(0, Math.min(100, (p.value / max) * 100))}%`, printColorAdjust: "exact", WebkitPrintColorAdjust: "exact" }} />
                    </div>
                    <div className="w-14 shrink-0 text-right font-semibold text-slate-700">{p.value.toLocaleString("en-GB")}{percent ? "%" : ""}</div>
                </div>
            ))}
        </div>
    );
}

export function MonthChart({ table }: { table: StatTable }) {
    const pts = chartPoints(table);
    if (pts.length === 0) return null;
    const percent = !!table.chart?.percent;
    const valueName = table.columns[table.chart!.value] || "Value";
    return (
        <div className="h-56 w-full my-3">
            <ResponsiveContainer width="100%" height="100%">
                <BarChart data={pts} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                    <XAxis dataKey="label" stroke="#6b7280" fontSize={11} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                    <YAxis stroke="#6b7280" fontSize={11} tickLine={false} axisLine={false} width={40} domain={percent ? [0, 100] : [0, "auto"]} tickFormatter={v => (percent ? `${v}%` : String(v))} />
                    <Tooltip cursor={{ fill: "#f3f4f6" }} formatter={(v: any) => [`${Number(v).toLocaleString("en-GB")}${percent ? "%" : ""}`, valueName]} />
                    <Bar dataKey="value" fill="#2c4a00" radius={[3, 3, 0, 0]} />
                </BarChart>
            </ResponsiveContainer>
        </div>
    );
}
