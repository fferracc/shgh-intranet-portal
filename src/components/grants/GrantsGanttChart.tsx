"use client";

import React, { useMemo } from 'react';
import { ExternalLink } from 'lucide-react';
import { formatUkDate, ymdToLocalDate } from '@/lib/grants/dates';

interface GanttGrant {
    id: string;
    grantName: string;
    funder: string;
    deadline: string | null;
    status: string;
    amount: number;
    description?: string;
    link?: string;
    index?: number;
}

interface GrantsGanttChartProps {
    grants: GanttGrant[];
}

export function GrantsGanttChart({ grants }: GrantsGanttChartProps) {
    const chartData = useMemo(() => {
        const allHaveToApply = grants.filter(g => g.status === 'Have to Apply');
        const withDeadline = allHaveToApply.filter(g => g.deadline);
        const rolling = allHaveToApply.filter(g => !g.deadline);

        if (allHaveToApply.length === 0) return null;

        const now = new Date();

        // Fixed range: 1 month past to 11 months future
        const startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const endDate = new Date(now.getFullYear(), now.getMonth() + 12, 0);
        const totalMs = endDate.getTime() - startDate.getTime();

        // Month markers
        const months: { label: string; left: number }[] = [];
        const cursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
        while (cursor <= endDate) {
            const pct = ((cursor.getTime() - startDate.getTime()) / totalMs) * 100;
            months.push({
                label: cursor.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }),
                left: pct
            });
            cursor.setMonth(cursor.getMonth() + 1);
        }

        const nowPct = ((now.getTime() - startDate.getTime()) / totalMs) * 100;

        const bars = withDeadline
            .map(g => {
                // Deadlines are 'YYYY-MM-DD' days (1 Oct 2026), placed at local midnight: no one day shift.
                const deadlineDate = ymdToLocalDate(g.deadline!);
                if (!deadlineDate) return null;
                const position = ((deadlineDate.getTime() - startDate.getTime()) / totalMs) * 100;
                if (position < -5 || position > 105) return null;
                return {
                    ...g,
                    deadlineDate,
                    position: Math.max(2, Math.min(position, 98)),
                    dateLabel: formatUkDate(g.deadline!, { day: 'numeric', month: 'short' })
                };
            })
            .filter(Boolean) as any[];

        bars.sort((a: any, b: any) => a.position - b.position);

        return { bars, months, nowPct, rolling };
    }, [grants]);

    if (!chartData) {
        return (
            <div className="bg-white rounded-lg border shadow-sm p-12 text-center text-slate-400">
                No grants with status "Have to Apply" found.
            </div>
        );
    }

    return (
        <div className="bg-white rounded-lg border shadow-sm overflow-hidden">
            {/* Header - sits above the chart area */}
            <div className="px-5 py-3 border-b bg-slate-50 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-slate-800">Applications to Submit</span>
                    <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full font-medium">Have to Apply</span>
                </div>
                <span className="text-xs text-slate-500">{chartData.bars.length} upcoming</span>
            </div>

            <div className="px-5 pt-3 pb-5 overflow-x-auto min-h-[300px]">
                <div className="min-w-[800px]">
                    {/* Month row - clearly separated from content */}
                    <div className="relative h-7 mb-1">
                        {chartData.months.map((m, i) => (
                            <div
                                key={i}
                                className="absolute bottom-0 text-[11px] text-slate-400 font-semibold"
                                style={{ left: `${m.left}%`, transform: 'translateX(-50%)' }}
                            >
                                {m.label}
                            </div>
                        ))}
                    </div>

                    {/* Timeline grid */}
                    <div className="relative border-t border-slate-200 pt-2">
                        {/* Grid lines */}
                        {chartData.months.map((m, i) => (
                            <div
                                key={`vl-${i}`}
                                className="absolute top-0 bottom-0 w-px bg-slate-100"
                                style={{ left: `${m.left}%` }}
                            />
                        ))}

                        {/* TODAY */}
                        <div
                            className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-10"
                            style={{ left: `${chartData.nowPct}%` }}
                        >
                            <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-[9px] bg-red-500 text-white px-1.5 py-0.5 rounded font-bold whitespace-nowrap shadow">
                                TODAY
                            </span>
                        </div>

                        {/* Rows */}
                        {chartData.bars.map((bar: any) => (
                            <div key={bar.id} className="relative flex items-center h-11 mb-0.5 group hover:bg-purple-50/30 rounded transition-colors">
                                <div className="absolute left-0 top-0 h-full flex items-center justify-between z-20 w-[190px] pr-2">
                                    <div className="pl-1 truncate flex-1">
                                        <div className="text-[11px] font-semibold text-slate-800 truncate" title={bar.grantName}>
                                            {bar.index ? `${bar.index}. ` : ''}{bar.grantName}
                                        </div>
                                        <div className="text-[9px] text-slate-400 truncate" title={bar.funder}>{bar.funder}</div>
                                    </div>
                                    {bar.link && (
                                        <a
                                            href={bar.link}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="text-purple-400 hover:text-purple-700 transition-colors p-1 flex-shrink-0"
                                            onClick={e => e.stopPropagation()}
                                            title="Open Funding Link"
                                        >
                                            <ExternalLink size={12} />
                                        </a>
                                    )}
                                </div>

                                <div
                                    className="absolute top-1/2 h-px -translate-y-1/2 bg-purple-200"
                                    style={{ left: '195px', width: `calc(${bar.position}% - 195px)` }}
                                />

                                <div
                                    className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 z-20 flex flex-col items-center"
                                    style={{ left: `${bar.position}%` }}
                                >
                                    <div className="w-3.5 h-3.5 rounded-full bg-purple-500 border-2 border-white shadow group-hover:scale-110 transition-transform" />
                                    <span className="mt-0.5 text-[9px] font-bold text-purple-700 whitespace-nowrap">
                                        {bar.dateLabel}
                                    </span>
                                </div>

                                <div className="absolute hidden group-hover:flex flex-col gap-1 bg-slate-900 text-white text-[10px] px-3 py-2 rounded-lg shadow-xl z-30 pointer-events-none max-w-[280px]"
                                    style={{ left: `${Math.min(bar.position + 2, 75)}%`, top: '-6px' }}>
                                    <div className="font-bold border-b border-slate-700 pb-1 mb-1">{bar.grantName}</div>
                                    <div className="whitespace-nowrap">{bar.funder}, £{bar.amount?.toLocaleString()}, deadline {formatUkDate(bar.deadline)}</div>
                                    {bar.description && (
                                        <div className="text-slate-300 mt-1 leading-tight line-clamp-3 text-[9px] whitespace-normal">
                                            {bar.description}
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* Legend */}
                    <div className="flex items-center gap-5 mt-4 pt-3 border-t border-slate-100">
                        <div className="flex items-center gap-1.5">
                            <div className="w-3 h-3 rounded-full bg-purple-500 border-2 border-white shadow-sm" />
                            <span className="text-[10px] text-slate-500 font-medium">Deadline</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <div className="w-3 h-0.5 bg-red-500 rounded" />
                            <span className="text-[10px] text-slate-500 font-medium">Today</span>
                        </div>
                        {chartData.rolling.length > 0 && (
                            <div className="flex items-center gap-1.5">
                                <div className="w-3 h-3 rounded border-2 border-dashed border-amber-400" />
                                <span className="text-[10px] text-slate-500 font-medium">Rolling basis</span>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Rolling Basis Section */}
            {chartData.rolling.length > 0 && (
                <div className="px-5 pb-4">
                    <div className="border border-dashed border-amber-300 rounded-lg bg-amber-50/40 p-3">
                        <div className="text-[10px] font-bold text-amber-700 uppercase tracking-wide mb-2">Rolling basis: no set deadline</div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                            {chartData.rolling.map((g: any) => (
                                <div key={g.id} className="relative flex items-center justify-between bg-white rounded px-3 py-2 border border-amber-200 group">
                                    <div className="flex items-center gap-2 min-w-0 flex-1 pr-2">
                                        <div className="w-2.5 h-2.5 rounded border-2 border-dashed border-amber-400 shrink-0" />
                                        <div className="min-w-0 flex-1">
                                            <div className="text-xs font-semibold text-slate-800 truncate" title={g.grantName}>
                                                {g.index ? `${g.index}. ` : ''}{g.grantName}
                                            </div>
                                            <div className="text-[10px] text-slate-500 truncate">{g.funder}{g.amount > 0 ? `, £${g.amount.toLocaleString()}` : ''}</div>
                                        </div>
                                    </div>
                                    {g.link && (
                                        <a
                                            href={g.link}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="text-amber-500 hover:text-amber-700 transition-colors p-1 flex-shrink-0"
                                            title="Open Funding Link"
                                        >
                                            <ExternalLink size={12} />
                                        </a>
                                    )}

                                    {/* Hover Tooltip for Description */}
                                    {g.description && (
                                        <div className="absolute hidden group-hover:flex flex-col gap-1 bg-slate-900 text-white text-[10px] px-3 py-2 rounded-lg shadow-xl z-30 pointer-events-none max-w-[280px]"
                                            style={{ left: '50%', bottom: '100%', transform: 'translate(-50%, -8px)' }}>
                                            <div className="font-bold border-b border-slate-700 pb-1 mb-1">{g.grantName}</div>
                                            <div className="whitespace-nowrap">{g.funder}, £{g.amount?.toLocaleString()}, rolling</div>
                                            <div className="text-slate-300 mt-1 leading-tight line-clamp-3 text-[9px] whitespace-normal">
                                                {g.description}
                                            </div>
                                            {/* decorative triangle */}
                                            <div className="absolute w-0 h-0 border-l-[6px] border-r-[6px] border-t-[6px] border-l-transparent border-r-transparent border-t-slate-900" style={{ bottom: '-6px', left: '50%', transform: 'translateX(-50%)' }} />
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
