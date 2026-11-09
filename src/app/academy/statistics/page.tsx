"use client";

// Master Statistics page (30 Sep 2026, Franco). Every statistic in the portal, for a chosen
// period and course filters, and a report builder (print or PDF, Excel, Word, saved templates).
// It replaces the Funders Report. Figures: src/lib/statistics/compute.ts (built on src/lib/stats.ts).
import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, RefreshCw, Search, AlertCircle } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { RequirePermission } from "@/components/auth/RequirePermission";
import type { DateRange } from "@/lib/stats";
import { loadStatistics, readCache, writeCache, type LoadResult } from "@/lib/statistics/load";
import { computeStatistics } from "@/lib/statistics/compute";
import { PERIOD_OPTIONS, periodRange, periodText, type PeriodRule } from "@/lib/statistics/periods";
import type { CourseStatusFilter, CourseTypeFilter, ReportSelection } from "@/lib/statistics/model";
import { aiPrompt, downloadExcel, downloadWord, generatedText, reportSections, sectionOn, type ReportMeta } from "@/lib/statistics/report";
import type { TemplateSelection } from "@/lib/statistics/templates";
import { SectionView, sectionMatches } from "@/components/statistics/SectionView";
import { PrintReport } from "@/components/statistics/PrintReport";
import { ReportPanel, type ReportFields } from "@/components/statistics/ReportPanel";
import { httpsCallable } from "firebase/functions";
import { functions } from "@/lib/firebase";

export default function StatisticsPage() {
    return (
        <RequirePermission perm="statistics">
            <StatisticsContent />
        </RequirePermission>
    );
}

const TYPE_OPTIONS: { value: CourseTypeFilter; label: string }[] = [
    { value: "all", label: "All course types" }, { value: "Rolling", label: "Rolling" }, { value: "Drop-in", label: "Drop-in" }, { value: "1-2-1", label: "1-2-1" },
];
const STATUS_OPTIONS: { value: CourseStatusFilter; label: string }[] = [
    { value: "all", label: "Any status" }, { value: "running", label: "Running" }, { value: "finished", label: "Finished" },
];

function filtersText(t: CourseTypeFilter, s: CourseStatusFilter): string {
    const type = t === "all" ? "All course types" : `${t} courses`;
    const status = s === "all" ? "any status" : s === "running" ? "running only" : "finished only";
    return `${type}, ${status}`;
}

function StatisticsContent() {
    const { user } = useAuth();
    const uid = user?.uid || "";
    const [result, setResult] = useState<LoadResult | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState("");

    const load = useCallback(async (fresh: boolean) => {
        if (!uid) return;
        if (!fresh) {
            const hit = readCache(uid);
            if (hit) { setResult(hit); setLoading(false); return; }
        }
        setLoading(true);
        setLoadError("");
        try {
            const r = await loadStatistics();
            setResult(r);
            writeCache(uid, r);
        } catch (e) {
            console.error("Statistics could not be loaded", e);
            setLoadError("The statistics could not be loaded. Please try Refresh.");
        } finally {
            setLoading(false);
        }
    }, [uid]);
    useEffect(() => { load(false); }, [load]);

    // Controls
    const [rule, setRule] = useState<PeriodRule>("thisFY");
    const [custom, setCustom] = useState<DateRange>({});
    const [typeFilter, setTypeFilter] = useState<CourseTypeFilter>("all");
    const [statusFilter, setStatusFilter] = useState<CourseStatusFilter>("all");
    const [search, setSearch] = useState("");
    const range = useMemo(() => periodRange(rule, custom), [rule, custom]);
    const setDate = (k: "from" | "to", v: string) => { setCustom({ ...range, [k]: v || undefined }); setRule("custom"); };

    const sections = useMemo(() => {
        if (!result) return [];
        try {
            return computeStatistics(result.raw, { range, typeFilter, statusFilter });
        } catch (e) {
            console.error("Statistics could not be worked out", e);
            return [];
        }
    }, [result, range, typeFilter, statusFilter]);

    // Report builder
    const [sel, setSel] = useState<ReportSelection>({ sections: {}, kpis: {}, tables: {} });
    const [fields, setFields] = useState<ReportFields>({ title: "Impact report", subtitle: "", notes: "", includeNames: false });
    const [busy, setBusy] = useState("");
    const [promptText, setPromptText] = useState("");
    const [aiText, setAiText] = useState("");
    const docs = useMemo(() => reportSections(sections, sel, fields.includeNames), [sections, sel, fields.includeNames]);
    const meta: ReportMeta = {
        title: fields.title, subtitle: fields.subtitle, notes: fields.notes, includeNames: fields.includeNames,
        periodText: periodText(range), filtersText: filtersText(typeFilter, statusFilter), generated: generatedText(),
    };
    const current = (): TemplateSelection => ({
        ...sel, ...fields, periodRule: rule, customFrom: rule === "custom" ? range.from : undefined, customTo: rule === "custom" ? range.to : undefined, typeFilter, statusFilter,
    });
    const apply = (t: TemplateSelection) => {
        setSel({ sections: t.sections || {}, kpis: t.kpis || {}, tables: t.tables || {} });
        setFields({ title: t.title || "", subtitle: t.subtitle || "", notes: t.notes || "", includeNames: t.includeNames === true });
        setRule(t.periodRule || "all");
        setCustom({ from: t.customFrom, to: t.customTo });
        setTypeFilter(t.typeFilter || "all");
        setStatusFilter(t.statusFilter || "all");
    };
    const run = async (kind: string, fn: () => Promise<void>) => {
        setBusy(kind);
        try { await fn(); }
        catch (e) { console.error(e); alert("The document could not be made. Please try again."); }
        finally { setBusy(""); }
    };
    // AI summary on the server (1 Oct 2026): only the ticked figures, no names, no class report text.
    const writeSummary = () => run("ai", async () => {
        const prompt = aiPrompt(docs, meta);
        try {
            const res: any = await httpsCallable(functions, "aiGrants", { timeout: 120000 })({ action: "summarize_stats", payload: { prompt } });
            setAiText(String(res?.data?.result || "The AI returned nothing. Please try again."));
        } catch (e: any) {
            setAiText(`The summary could not be written: ${e?.message || "unknown error"}`);
        }
    });
    const copyPrompt = async () => {
        const text = aiPrompt(docs, meta);
        try { await navigator.clipboard.writeText(text); setPromptText(""); alert("Copied. Paste it into your AI assistant (for example Gemini). It holds figures only, no names."); }
        catch { setPromptText(text); }
    };

    const q = search.trim().toLowerCase();
    const shown = sections.filter(s => sectionMatches(s, q));
    const at = result ? new Date(result.at) : null;
    const atText = at ? `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}` : "";

    return (
        <>
            <div className="space-y-6 print:hidden">
                <div className="flex flex-wrap justify-between items-start gap-4">
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight text-slate-900 flex items-center gap-3"><BarChart3 className="text-[#2c4a00]" /> Statistics</h1>
                        <p className="text-slate-500">Every figure in the portal for the period you choose. Tick what you need and build a report for funders or anyone else.</p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                        <button onClick={() => load(true)} disabled={loading} className="inline-flex items-center gap-2 rounded-md text-sm font-medium bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 h-10 px-4 shadow-sm disabled:opacity-50">
                            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
                        </button>
                        {atText && <span className="text-[11px] text-slate-400">Figures read at {atText}, kept for 10 minutes</span>}
                    </div>
                </div>

                {loadError && <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md p-3">{loadError}</p>}
                {result && result.failed.length > 0 && (
                    <div role="alert" className="flex flex-wrap gap-2">
                        {result.failed.map(f => (
                            <span key={f} className="inline-flex items-center gap-1 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-full px-3 py-1"><AlertCircle size={12} /> Could not load: {f}</span>
                        ))}
                    </div>
                )}

                {/* Controls */}
                <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm space-y-3">
                    <div className="flex flex-wrap gap-2">
                        {PERIOD_OPTIONS.map(p => (
                            <button key={p.rule} onClick={() => { if (p.rule === "custom") setCustom(range); setRule(p.rule); }}
                                className={`text-xs px-3 py-2 rounded-md border ${rule === p.rule ? "bg-[#2c4a00] text-white border-[#2c4a00]" : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"}`}>
                                {p.label}
                            </button>
                        ))}
                    </div>
                    <div className="flex flex-wrap items-end gap-4">
                        <label className="text-sm text-slate-700">From
                            <input type="date" value={range.from || ""} max={range.to || undefined} onChange={e => setDate("from", e.target.value)} className="block mt-1 p-2 border border-slate-300 rounded-md text-sm" />
                        </label>
                        <label className="text-sm text-slate-700">To
                            <input type="date" value={range.to || ""} min={range.from || undefined} onChange={e => setDate("to", e.target.value)} className="block mt-1 p-2 border border-slate-300 rounded-md text-sm" />
                        </label>
                        <label className="text-sm text-slate-700">Course type
                            <select value={typeFilter} onChange={e => setTypeFilter(e.target.value as CourseTypeFilter)} className="block mt-1 p-2 border border-slate-300 rounded-md text-sm bg-white">
                                {TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                        </label>
                        <label className="text-sm text-slate-700">Course status
                            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as CourseStatusFilter)} className="block mt-1 p-2 border border-slate-300 rounded-md text-sm bg-white">
                                {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                        </label>
                        <label className="text-sm text-slate-700 flex-1 min-w-[14rem]">Search
                            <span className="relative block mt-1">
                                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="A course, a person, a figure…" className="w-full pl-8 p-2 border border-slate-300 rounded-md text-sm" />
                            </span>
                        </label>
                    </div>
                    <p className="text-xs text-slate-500">Showing <strong>{periodText(range)}</strong>, {filtersText(typeFilter, statusFilter).toLowerCase()}. Figures marked &quot;now&quot; are today&apos;s. {q && "The search only narrows what is on screen, not the report."}</p>
                </div>

                <ReportPanel
                    fields={fields} setFields={setFields}
                    sectionCount={docs.length} kpiCount={docs.reduce((t, d) => t + d.kpis.length, 0)} tableCount={docs.reduce((t, d) => t + d.tables.length, 0)}
                    onPrint={() => window.print()}
                    onExcel={() => run("excel", () => downloadExcel(docs, meta))}
                    onWord={() => run("word", () => downloadWord(docs, meta))}
                    onPrompt={copyPrompt}
                    onAiSummary={writeSummary}
                    busy={busy} current={current} apply={apply} uid={uid}
                />
                {aiText && (
                    <div className="bg-white rounded-xl border border-slate-200 p-4">
                        <div className="flex justify-between items-center mb-2">
                            <p className="text-sm font-semibold text-slate-700">AI summary (check every figure before you send it)</p>
                            <div className="flex gap-3">
                                <button onClick={async () => { try { await navigator.clipboard.writeText(aiText); } catch { /* select by hand */ } }} className="text-xs text-slate-600 hover:underline">Copy</button>
                                <button onClick={() => setAiText("")} className="text-xs text-slate-500 hover:underline">Close</button>
                            </div>
                        </div>
                        <textarea value={aiText} onChange={e => setAiText(e.target.value)} rows={14} className="w-full p-2 border border-slate-300 rounded-md text-sm" />
                    </div>
                )}
                {promptText && (
                    <div className="bg-white rounded-xl border border-slate-200 p-4">
                        <div className="flex justify-between items-center mb-2">
                            <p className="text-sm text-slate-700">Copying was blocked by the browser. Select the text below and copy it.</p>
                            <button onClick={() => setPromptText("")} className="text-xs text-slate-500 hover:underline">Close</button>
                        </div>
                        <textarea readOnly value={promptText} rows={10} className="w-full p-2 border border-slate-300 rounded-md text-xs font-mono" onFocus={e => e.currentTarget.select()} />
                    </div>
                )}

                {/* Jump to a section */}
                {sections.length > 0 && (
                    <nav className="flex flex-wrap gap-2" aria-label="Sections">
                        {sections.map(s => (
                            <button key={s.id} onClick={() => document.getElementById(`stat-${s.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                                className={`text-xs px-3 py-1.5 rounded-full border ${sectionOn(sel, s.id) ? "bg-[#2c4a00]/10 border-[#2c4a00]/40 text-[#2c4a00] font-semibold" : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"}`}>
                                {s.number}. {s.title}
                            </button>
                        ))}
                    </nav>
                )}

                {loading && !result ? (
                    <div className="flex h-64 items-center justify-center flex-col gap-3 text-slate-500">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#2c4a00]" />
                        <p className="text-sm">Reading every collection once. This can take a few seconds.</p>
                    </div>
                ) : (
                    <div className="space-y-6">
                        {shown.map(s => (
                            <SectionView key={s.id} section={s} sel={sel} setSel={setSel} search={search} includeNames={fields.includeNames} />
                        ))}
                        {result && shown.length === 0 && <p className="text-sm text-slate-500 italic">Nothing matches the search.</p>}
                    </div>
                )}
            </div>
            <PrintReport docs={docs} meta={meta} />
        </>
    );
}
