"use client";

// Draws any application form from its template (29 Sep 2026). Used by the public
// pages /volunteer and /apply, and by the preview in the form editor.
import { NATIONALITY_OPTIONS } from "@/lib/countries";
import { DAYS, SLOTS } from "@/lib/volunteerForm";
import { Answer, FormTemplate, Question } from "@/lib/formTemplates";

const base = "w-full p-3 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white";

export interface RendererProps {
    template: FormTemplate;
    values: Record<string, Answer>;
    extras: Record<string, string>;
    setValue: (id: string, v: Answer) => void;
    setExtra: (id: string, v: string) => void;
    cv?: File | null;
    onCv?: (f: File | null) => void;
}

function Choice({ q, value, onChange }: { q: Question; value: string; onChange: (v: string) => void }) {
    const opts = [...(q.options || []), ...(q.other ? ["Other"] : [])];
    if (q.type === "select") {
        return (
            <select id={q.id} className={base} value={value} onChange={e => onChange(e.target.value)}>
                <option value="">Choose…</option>
                {opts.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
        );
    }
    return (
        <div className="flex flex-col gap-2" role="radiogroup" aria-labelledby={`${q.id}-label`}>
            {opts.map(o => (
                <label key={o} className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name={q.id} value={o} checked={value === o} onChange={() => onChange(o)} className="w-4 h-4 accent-emerald-600" />
                    <span>{o}</span>
                </label>
            ))}
        </div>
    );
}

function QuestionInput({ q, p }: { q: Question; p: RendererProps }) {
    const v = p.values[q.id];
    const str = typeof v === "string" ? v : "";
    const set = (x: Answer) => p.setValue(q.id, x);
    switch (q.type) {
        case "radio":
        case "select":
            return (
                <>
                    <Choice q={q} value={str} onChange={set} />
                    {q.other && str === "Other" && <input className={`${base} mt-2`} maxLength={120} placeholder="Please describe" value={p.extras[q.id + "Other"] || ""} onChange={e => p.setExtra(q.id + "Other", e.target.value)} />}
                </>
            );
        case "checkboxes": {
            const cur = Array.isArray(v) ? (v as string[]) : [];
            return (
                <div className="flex flex-col gap-2">
                    {(q.options || []).map(o => (
                        <label key={o} className="flex items-center gap-2 cursor-pointer">
                            <input type="checkbox" checked={cur.includes(o)} onChange={() => set(cur.includes(o) ? cur.filter(x => x !== o) : [...cur, o])} className="w-4 h-4 accent-emerald-600" />
                            <span>{o}</span>
                        </label>
                    ))}
                </div>
            );
        }
        case "textarea":
            return (
                <>
                    <textarea id={q.id} className={`${base} min-h-[120px]`} maxLength={q.maxLength || 1500} value={str} onChange={e => set(e.target.value)} />
                    <p className="text-xs text-slate-400 mt-1 text-right">{str.length} / {q.maxLength || 1500}</p>
                </>
            );
        case "country":
            return (
                <select id={q.id} className={base} value={str} onChange={e => set(e.target.value)}>
                    <option value="">Select a country</option>
                    {NATIONALITY_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
            );
        case "likert": {
            const m = (v || {}) as Record<string, string>;
            return (
                <div className="space-y-3">
                    {(q.statements || []).map(s => (
                        <div key={s.id} className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                            <p className="text-sm text-slate-700 mb-2">{s.text}</p>
                            <div className="flex gap-2 flex-wrap">
                                {(q.scale || []).map(a => (
                                    <button type="button" key={a} onClick={() => set({ ...m, [s.id]: a })} aria-pressed={m[s.id] === a}
                                        className={`px-3 py-1.5 rounded-full text-sm border ${m[s.id] === a ? "bg-emerald-600 text-white border-emerald-600" : "bg-white text-slate-700 border-slate-300"}`}>{a}</button>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            );
        }
        case "availability": {
            const m = (v || {}) as Record<string, string[]>;
            const toggle = (day: string, slot: string) => {
                const cur = new Set(m[day] || []);
                if (cur.has(slot)) cur.delete(slot); else cur.add(slot);
                set({ ...m, [day]: SLOTS.filter(s => cur.has(s)) });
            };
            return (
                <div className="space-y-3">
                    {DAYS.map(day => (
                        <div key={day}>
                            <p className="font-semibold text-slate-700 text-sm mb-1">{day}</p>
                            <div className="flex flex-wrap gap-1.5">
                                {SLOTS.map(s => {
                                    const on = (m[day] || []).includes(s);
                                    return <button type="button" key={s} onClick={() => toggle(day, s)} aria-pressed={on}
                                        className={`px-2 py-1 rounded text-xs border ${on ? "bg-emerald-600 text-white border-emerald-600" : "bg-white text-slate-600 border-slate-300"}`}>{s}</button>;
                                })}
                            </div>
                        </div>
                    ))}
                </div>
            );
        }
        case "cv":
            return (
                <div className="flex flex-wrap items-center gap-3 p-4 rounded-lg border-2 border-dashed border-emerald-300 bg-emerald-50">
                    <label className="inline-flex items-center gap-2 px-5 py-3 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold cursor-pointer focus-within:ring-2 focus-within:ring-emerald-500 focus-within:ring-offset-2">
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
                        {p.cv ? "Choose a different file" : "Attach your CV (PDF)"}
                        <input type="file" accept="application/pdf,.pdf" className="sr-only" onChange={e => { p.onCv?.(e.target.files?.[0] || null); e.target.value = ""; }} />
                    </label>
                    {p.cv
                        ? <span className="text-sm text-emerald-800 font-medium break-all">{p.cv.name} ({(p.cv.size / 1024 / 1024).toFixed(1)} MB) attached <button type="button" onClick={() => p.onCv?.(null)} className="ml-2 text-red-600 underline font-normal">Remove</button></span>
                        : <span className="text-sm text-slate-500">No file attached yet</span>}
                </div>
            );
        case "number":
            return <input id={q.id} inputMode="numeric" className={base} maxLength={q.maxLength || 6} value={str} onChange={e => set(e.target.value.replace(/[^0-9]/g, ""))} />;
        case "date":
            return <input id={q.id} type="date" className={base} max={new Date().toISOString().slice(0, 10)} value={str} onChange={e => set(e.target.value)} />;
        default:
            return <input id={q.id} type={q.type === "email" ? "email" : q.type === "tel" ? "tel" : "text"} className={base} maxLength={q.maxLength || 200} value={str} onChange={e => set(e.target.value)}
                autoComplete={q.id === "name" ? "name" : q.id === "email" ? "email" : q.type === "tel" ? "tel" : undefined} />;
    }
}

export default function FormRenderer(p: RendererProps) {
    return (
        <div className="space-y-7">
            {p.template.questions.map((q, i) => (
                <div key={q.id} className={q.type === "availability" || q.type === "cv" ? "pt-4 border-t" : ""}>
                    <p id={`${q.id}-label`} className="font-semibold text-slate-800 mb-1">
                        {i + 1}. {q.label}{q.required ? <span className="text-red-600" aria-hidden> *</span> : <span className="text-slate-400 font-normal"> (optional)</span>}
                    </p>
                    {q.help && <p className="text-sm text-slate-500 mb-2">{q.help}</p>}
                    <QuestionInput q={q} p={p} />
                </div>
            ))}
        </div>
    );
}
