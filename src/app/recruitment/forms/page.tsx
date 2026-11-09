"use client";

// Application Forms editor (29 Sep 2026). Super admin only.
// Edit every question of the four public forms: wording, help text, options, required,
// order; add and delete questions. Core questions (the ones Accept copies into the new
// volunteer or student record) can be reworded but not deleted. Saving updates every open
// link at once; past applications keep the wording they were answered with.
import DashboardLayout from "@/components/layout/DashboardLayout";
import { useEffect, useMemo, useState } from "react";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";
import {
    ALL_FORM_IDS, ANSWERS_MAX, answerSlots, dbLimit, DEFAULT_MAX, DEFAULT_TEMPLATES, EDITABLE_TYPES, FormId, FormTemplate, GROUP_COLORS,
    limitProblems, newQuestionId, newStatementId, Question, QType, QUESTIONS_MAX, resolveTemplate, STATEMENTS_MAX, TYPE_LABEL,
} from "@/lib/formTemplates";
import { ArrowDown, ArrowUp, Eye, Lock, Plus, RotateCcw, Save, ShieldAlert, Trash2 } from "lucide-react";

const input = "w-full p-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white";
const CHOICE: QType[] = ["radio", "select", "checkboxes"];
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

function previewUrl(id: FormId) {
    return id === "volunteer" ? "/volunteer?preview=1" : `/apply?form=${id}&preview=1`;
}

function QuestionCard({ q, n, total, t, onChange, onMove, onDelete }: {
    q: Question; n: number; total: number; t: FormTemplate;
    onChange: (q: Question) => void; onMove: (dir: -1 | 1) => void; onDelete: () => void;
}) {
    const set = (patch: Partial<Question>) => onChange({ ...q, ...patch });
    const groups = t.groups || [];
    // The longest answer can never be more than the database keeps (1 Oct 2026).
    const limit = dbLimit(t.id, q) ?? (q.type === "textarea" ? 3000 : 500);
    const shownMax = Math.min(q.maxLength || DEFAULT_MAX[q.type] || limit, limit);
    return (
        <div className={`rounded-xl border p-4 bg-white ${q.core ? "border-slate-300" : "border-blue-200"}`}>
            <div className="flex flex-wrap items-center gap-2 mb-3">
                <span className="text-sm font-bold text-slate-500">{n}.</span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">{TYPE_LABEL[q.type]}</span>
                {q.core && <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 flex items-center gap-1" title="Copied into the new record when you accept someone. It can be reworded but not deleted."><Lock size={11} /> Core</span>}
                {q.private && <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-800">Private</span>}
                <div className="ml-auto flex gap-1">
                    <button type="button" onClick={() => onMove(-1)} disabled={n === 1} className="p-1.5 rounded border border-slate-200 disabled:opacity-30 hover:bg-slate-50" aria-label="Move up"><ArrowUp size={14} /></button>
                    <button type="button" onClick={() => onMove(1)} disabled={n === total} className="p-1.5 rounded border border-slate-200 disabled:opacity-30 hover:bg-slate-50" aria-label="Move down"><ArrowDown size={14} /></button>
                    {!q.core && <button type="button" onClick={onDelete} className="p-1.5 rounded border border-red-200 text-red-600 hover:bg-red-50" aria-label="Delete question"><Trash2 size={14} /></button>}
                </div>
            </div>
            <div className="grid gap-3">
                <label className="text-xs font-semibold text-slate-600">Question
                    <input className={input} value={q.label} onChange={e => set({ label: e.target.value })} maxLength={300} />
                </label>
                <label className="text-xs font-semibold text-slate-600">Help text (optional, shown under the question)
                    <textarea className={`${input} min-h-[56px]`} value={q.help || ""} onChange={e => set({ help: e.target.value })} maxLength={600} />
                </label>
                <div className="flex flex-wrap gap-4 items-end">
                    {!q.core && (
                        <label className="text-xs font-semibold text-slate-600">Answer type
                            <select className={`${input} min-w-[14rem]`} value={q.type} onChange={e => {
                                const type = e.target.value as QType;
                                set({ type, options: CHOICE.includes(type) ? (q.options && q.options.length ? q.options : ["Option 1", "Option 2"]) : undefined, other: CHOICE.includes(type) && type !== "checkboxes" ? q.other : false });
                            }}>
                                {EDITABLE_TYPES.map(o => <option key={o.type} value={o.type}>{o.label}</option>)}
                            </select>
                        </label>
                    )}
                    <label className={`flex items-center gap-2 text-sm ${q.lockRequired ? "text-slate-400" : "text-slate-700"}`} title={q.lockRequired ? "This question must always be answered." : ""}>
                        <input type="checkbox" className="h-4 w-4 accent-blue-600" checked={!!q.required} disabled={q.lockRequired} onChange={e => set({ required: e.target.checked })} /> Required
                    </label>
                    {t.kind === "volunteer" && !q.core && (
                        <label className="flex items-center gap-2 text-sm text-slate-700" title="Private answers are kept apart and only admins and recruiters can see them.">
                            <input type="checkbox" className="h-4 w-4 accent-purple-600" checked={!!q.private} onChange={e => set({ private: e.target.checked })} /> Private
                        </label>
                    )}
                    {(q.type === "text" || q.type === "textarea") && (
                        <label className="text-xs font-semibold text-slate-600">Longest answer (characters, up to {limit})
                            <input type="number" min={1} max={limit} className={`${input} w-32`} value={shownMax}
                                onChange={e => set({ maxLength: Math.max(1, Math.min(limit, Number(e.target.value) || 0)) })} />
                        </label>
                    )}
                    {q.type === "textarea" && (
                        <label className="text-xs font-semibold text-slate-600">Shortest answer
                            <input type="number" min={0} max={Math.min(500, shownMax)} className={`${input} w-28`} value={q.minLength || 0} onChange={e => set({ minLength: Math.max(0, Math.min(500, shownMax, Number(e.target.value) || 0)) || undefined })} />
                        </label>
                    )}
                </div>
                {CHOICE.includes(q.type) && (
                    <div>
                        <label className="text-xs font-semibold text-slate-600">Options, one per line
                            <textarea className={`${input} min-h-[96px] font-mono`} value={(q.options || []).join("\n")}
                                onChange={e => set({ options: e.target.value.split("\n") })} />
                        </label>
                        {q.type !== "checkboxes" && (
                            <label className="flex items-center gap-2 text-sm text-slate-700 mt-2">
                                <input type="checkbox" className="h-4 w-4 accent-blue-600" checked={!!q.other} onChange={e => set({ other: e.target.checked })} /> Add &quot;Other&quot; with a box to describe
                            </label>
                        )}
                    </div>
                )}
                {q.type === "likert" && (
                    <div className="rounded-lg bg-slate-50 border p-3">
                        <p className="text-xs font-semibold text-slate-600 mb-2">Statements (answered {(q.scale || []).join(" / ")}). The group decides where each one appears in the chart.</p>
                        <div className="space-y-2">
                            {(q.statements || []).map((st, i) => (
                                <div key={st.id} className="flex flex-wrap gap-2 items-center">
                                    <input className={`${input} flex-1 min-w-[14rem]`} value={st.text} maxLength={300}
                                        onChange={e => { const list = [...(q.statements || [])]; list[i] = { ...st, text: e.target.value }; set({ statements: list }); }} />
                                    <select className={`${input} w-48`} value={st.group || ""} onChange={e => { const list = [...(q.statements || [])]; list[i] = { ...st, group: e.target.value }; set({ statements: list }); }}>
                                        {groups.map(g => <option key={g.name} value={g.name}>{g.name}</option>)}
                                    </select>
                                    <button type="button" disabled={(q.statements || []).length <= 1} onClick={() => set({ statements: (q.statements || []).filter(x => x.id !== st.id) })}
                                        className="p-2 rounded border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-30" aria-label="Delete statement"><Trash2 size={14} /></button>
                                </div>
                            ))}
                        </div>
                        <button type="button" disabled={(q.statements || []).length >= STATEMENTS_MAX} title={(q.statements || []).length >= STATEMENTS_MAX ? `The database keeps at most ${STATEMENTS_MAX} statements.` : ""}
                            onClick={() => set({ statements: [...(q.statements || []), { id: newStatementId(), text: "New statement", group: groups[0]?.name }] })}
                            className="disabled:opacity-40 mt-2 text-sm px-3 py-1.5 rounded border border-slate-300 bg-white hover:bg-slate-50 flex items-center gap-1"><Plus size={14} /> Add a statement</button>
                    </div>
                )}
                {q.type === "availability" && <p className="text-xs text-slate-500">Days Monday to Sunday, hours 09:00 to 20:00.</p>}
                {q.type === "cv" && <p className="text-xs text-slate-500">PDF only, up to 3 MB.</p>}
            </div>
        </div>
    );
}

function GroupsEditor({ t, onChange }: { t: FormTemplate; onChange: (t: FormTemplate) => void }) {
    const groups = t.groups || [];
    const used = new Set(t.questions.flatMap(q => (q.statements || []).map(s => s.group)));
    const rename = (i: number, name: string) => {
        const old = groups[i].name;
        const next = groups.map((g, j) => j === i ? { ...g, name } : g);
        onChange({ ...t, groups: next, questions: t.questions.map(q => q.statements ? { ...q, statements: q.statements.map(s => s.group === old ? { ...s, group: name } : s) } : q) });
    };
    return (
        <div className="rounded-xl border bg-white p-4">
            <h3 className="font-bold text-slate-800 text-sm mb-1">Chart categories for the statements</h3>
            <p className="text-xs text-slate-500 mb-3">Each statement belongs to one category. The application page shows a score per category.</p>
            <div className="space-y-2">
                {groups.map((g, i) => (
                    <div key={i} className="flex items-center gap-2">
                        <span className="w-4 h-4 rounded" style={{ background: g.color }} />
                        <input className={`${input} max-w-xs`} value={g.name} maxLength={40} onChange={e => rename(i, e.target.value)} />
                        <button type="button" disabled={used.has(g.name) || groups.length <= 1} onClick={() => onChange({ ...t, groups: groups.filter((_, j) => j !== i) })}
                            title={used.has(g.name) ? "Move its statements to another category first" : "Delete"} className="p-2 rounded border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-30"><Trash2 size={14} /></button>
                    </div>
                ))}
            </div>
            {groups.length < GROUP_COLORS.length && (
                <button type="button" onClick={() => onChange({ ...t, groups: [...groups, { name: `Category ${groups.length + 1}`, color: GROUP_COLORS[groups.length] }] })}
                    className="mt-2 text-sm px-3 py-1.5 rounded border border-slate-300 hover:bg-slate-50 flex items-center gap-1"><Plus size={14} /> Add a category</button>
            )}
        </div>
    );
}

function problems(t: FormTemplate): string[] {
    const out: string[] = [];
    if (!t.title.trim()) out.push("The form needs a title.");
    t.questions.forEach((q, i) => {
        if (!q.label.trim()) out.push(`Question ${i + 1} has no text.`);
        if (CHOICE.includes(q.type) && !(q.options || []).some(o => o.trim())) out.push(`Question ${i + 1} needs at least one option.`);
        const opts = (q.options || []).map(o => o.trim()).filter(Boolean);
        if (CHOICE.includes(q.type) && new Set(opts).size !== opts.length) out.push(`Question ${i + 1} has the same option twice.`);
        if (q.type === "likert" && (q.statements || []).some(s => !s.text.trim())) out.push(`Question ${i + 1} has an empty statement.`);
    });
    return [...out, ...limitProblems(t)];
}

function FormsEditor() {
    const { user } = useAuth();
    const [saved, setSaved] = useState<Record<string, FormTemplate>>({});
    const [formId, setFormId] = useState<FormId>("volunteer");
    const [draft, setDraft] = useState<FormTemplate | null>(null);
    const [addType, setAddType] = useState<QType>("text");
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<{ text: string; tone: "ok" | "err" } | null>(null);

    useEffect(() => {
        (async () => {
            const all: Record<string, FormTemplate> = {};
            for (const id of ALL_FORM_IDS) {
                try { const s = await getDoc(doc(db, "formTemplates", id)); all[id] = resolveTemplate(id, s.exists() ? s.data() as Partial<FormTemplate> : null); }
                catch { all[id] = resolveTemplate(id, null); }
            }
            setSaved(all);
            setDraft(clone(all.volunteer));
        })();
    }, []);

    const dirty = useMemo(() => !!draft && JSON.stringify(draft) !== JSON.stringify(saved[formId]), [draft, saved, formId]);
    useEffect(() => {
        const warn = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [dirty]);
    useEffect(() => { if (note?.tone === "ok") { const x = setTimeout(() => setNote(null), 8000); return () => clearTimeout(x); } }, [note]);

    if (!draft) return <div className="p-8 text-slate-500">Loading the forms…</div>;

    const pick = (id: FormId) => {
        if (dirty && !confirm("You have changes that are not saved. Leave them?")) return;
        setFormId(id); setDraft(clone(saved[id])); setNote(null);
    };
    const setQ = (i: number, q: Question) => setDraft({ ...draft, questions: draft.questions.map((x, j) => j === i ? q : x) });
    const move = (i: number, dir: -1 | 1) => {
        const qs = [...draft.questions]; const j = i + dir;
        if (j < 0 || j >= qs.length) return;
        [qs[i], qs[j]] = [qs[j], qs[i]];
        setDraft({ ...draft, questions: qs });
    };
    const del = (i: number) => {
        if (!confirm(`Delete question ${i + 1}: "${draft.questions[i].label}"?\n\nPast applications keep their answer to it.`)) return;
        setDraft({ ...draft, questions: draft.questions.filter((_, j) => j !== i) });
    };
    const slots = answerSlots(draft);
    const full = draft.questions.length >= QUESTIONS_MAX || slots.public >= ANSWERS_MAX;
    const add = () => {
        if (full) { setNote({ text: `No more questions can be added: the database keeps at most ${ANSWERS_MAX} added answers and ${QUESTIONS_MAX} questions per form.`, tone: "err" }); return; }
        const q: Question = { id: newQuestionId(), type: addType, label: "New question", required: false, core: false };
        if (CHOICE.includes(addType)) q.options = ["Option 1", "Option 2"];
        setDraft({ ...draft, questions: [...draft.questions, q] });
        setTimeout(() => { const m = document.querySelector("main"); m?.scrollTo({ top: m.scrollHeight, behavior: "smooth" }); }, 50);
    };
    const save = async () => {
        const p = problems(draft);
        if (p.length) { setNote({ text: p.join(" "), tone: "err" }); return; }
        if (!confirm(`Save the ${draft.name} form?\n\nEvery open link for this form will show the new version straight away.`)) return;
        setBusy(true);
        try {
            const clean: FormTemplate = {
                ...draft,
                questions: draft.questions.map(q => ({ ...q, options: q.options?.map(o => o.trim()).filter(Boolean) })),
                updatedAt: new Date().toISOString(), updatedBy: user?.uid || "", updatedByName: user?.displayName || "",
            };
            const final = resolveTemplate(draft.id, clean);
            const left = limitProblems(final);
            if (left.length) { setNote({ text: `Not saved. ${left.join(" ")}`, tone: "err" }); return; }
            await setDoc(doc(db, "formTemplates", draft.id), JSON.parse(JSON.stringify(clean)));
            const resolved = resolveTemplate(draft.id, clean);
            setSaved(s => ({ ...s, [draft.id]: resolved }));
            setDraft(clone(resolved));
            setNote({ text: `Saved. The ${draft.name} form is live with these questions.`, tone: "ok" });
        } catch (e) {
            // The real reason (1 Oct 2026), not a guess.
            console.error(e);
            const code = (e as { code?: string })?.code || "";
            const m = (e as { message?: string })?.message || String(e);
            const why = code === "permission-denied"
                ? "The database refused it: only a super admin can change the forms, and a form can have at most 80 questions."
                : code === "unavailable" ? "There is no connection to the database. Check your internet and try again."
                    : code === "invalid-argument" ? `The database could not store it (${m}).`
                        : `${m}${code ? ` (${code})` : ""}`;
            setNote({ text: `Not saved. ${why}`, tone: "err" });
        }
        finally { setBusy(false); }
    };
    const restore = () => {
        if (!confirm(`Put the ${draft.name} form back to the original questions?\n\nNothing changes until you press Save.`)) return;
        setDraft({ ...clone(DEFAULT_TEMPLATES[formId]), updatedAt: draft.updatedAt, updatedBy: draft.updatedBy, updatedByName: draft.updatedByName });
    };

    return (
        <div className="max-w-4xl pb-28">
            <h1 className="text-2xl font-bold text-slate-800">Application Forms</h1>
            <p className="text-slate-500 mb-4">Change the questions of the public forms. Saving updates every open link for that form at once. Past applications keep the questions they answered.</p>

            <div className="flex flex-wrap gap-2 mb-5" role="tablist">
                {ALL_FORM_IDS.map(id => (
                    <button key={id} role="tab" aria-selected={formId === id} onClick={() => pick(id)}
                        className={`px-4 py-2 rounded-lg text-sm font-semibold border ${formId === id ? "bg-blue-600 text-white border-blue-600" : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"}`}>
                        {saved[id]?.name || DEFAULT_TEMPLATES[id].name}
                    </button>
                ))}
            </div>

            <div className="rounded-xl border bg-white p-4 mb-4 grid gap-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span>{draft.kind === "volunteer" ? "Public link: shgh-portal.web.app/volunteer" : "Used by every Student Applications process that uses this form."}</span>
                    {draft.updatedAt && <span className="ml-auto">Last saved {new Date(draft.updatedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}{draft.updatedByName ? ` by ${draft.updatedByName}` : ""}</span>}
                </div>
                <label className="text-xs font-semibold text-slate-600">Form title
                    <input className={input} value={draft.title} maxLength={150} onChange={e => setDraft({ ...draft, title: e.target.value })} />
                </label>
                <label className="text-xs font-semibold text-slate-600">Introduction (under the title)
                    <textarea className={`${input} min-h-[64px]`} value={draft.intro} maxLength={1500} onChange={e => setDraft({ ...draft, intro: e.target.value })} />
                </label>
                <label className="text-xs font-semibold text-slate-600">Consent statement (the tick box at the end)
                    <textarea className={`${input} min-h-[56px]`} value={draft.consent} maxLength={800} onChange={e => setDraft({ ...draft, consent: e.target.value })} />
                </label>
                <label className="text-xs font-semibold text-slate-600">Thank you message (after sending)
                    <textarea className={`${input} min-h-[56px]`} value={draft.thankYou} maxLength={800} onChange={e => setDraft({ ...draft, thankYou: e.target.value })} />
                </label>
            </div>

            {draft.kind === "volunteer" && <div className="mb-4"><GroupsEditor t={draft} onChange={setDraft} /></div>}

            <div className="space-y-3">
                {draft.questions.map((q, i) => (
                    <QuestionCard key={q.id} q={q} n={i + 1} total={draft.questions.length} t={draft}
                        onChange={nq => setQ(i, nq)} onMove={dir => move(i, dir)} onDelete={() => del(i)} />
                ))}
            </div>

            <div className="mt-4 rounded-xl border-2 border-dashed border-blue-200 p-4 flex flex-wrap items-end gap-3 bg-blue-50/40">
                <label className="text-xs font-semibold text-slate-600">New question type
                    <select className={`${input} min-w-[14rem]`} value={addType} onChange={e => setAddType(e.target.value as QType)}>
                        {EDITABLE_TYPES.map(o => <option key={o.type} value={o.type}>{o.label}</option>)}
                    </select>
                </label>
                <button type="button" onClick={add} disabled={full} className="px-4 py-2 rounded-lg bg-white border border-blue-300 text-blue-700 font-semibold flex items-center gap-1 hover:bg-blue-50 disabled:opacity-50"><Plus size={16} /> Add a question</button>
                <p className="text-xs text-slate-500 w-full">Added answers: {slots.public} of {ANSWERS_MAX}{draft.kind === "volunteer" ? `, private ${slots.private} of ${ANSWERS_MAX}` : ""}. A question with &quot;Other&quot; uses two. Questions: {draft.questions.length} of {QUESTIONS_MAX}.</p>
            </div>

            <div className="fixed bottom-0 left-0 right-0 md:left-64 z-40 bg-white/95 backdrop-blur border-t p-3 flex flex-wrap items-center gap-2 justify-end">
                {note && <span role={note.tone === "err" ? "alert" : "status"} className={`mr-auto text-sm font-semibold ${note.tone === "ok" ? "text-green-700" : "text-red-600"}`}>{note.tone === "ok" ? "✓ " : ""}{note.text}</span>}
                {!note && dirty && <span className="mr-auto text-sm text-amber-700 font-semibold">Changes not saved yet</span>}
                <button type="button" onClick={restore} className="px-3 py-2 rounded-lg border border-slate-300 text-sm flex items-center gap-1 hover:bg-slate-50"><RotateCcw size={14} /> Original questions</button>
                {dirty && <button type="button" onClick={() => setDraft(clone(saved[formId]))} className="px-3 py-2 rounded-lg border border-slate-300 text-sm hover:bg-slate-50">Discard changes</button>}
                <a href={previewUrl(formId)} target="_blank" rel="noreferrer" onClick={e => { if (dirty) { e.preventDefault(); alert("Save first: the preview shows the saved form."); } }}
                    className="px-3 py-2 rounded-lg border border-slate-300 text-sm flex items-center gap-1 hover:bg-slate-50"><Eye size={14} /> Preview</a>
                <button type="button" onClick={save} disabled={!dirty || busy} className="px-4 py-2 rounded-lg bg-blue-600 text-white font-semibold text-sm flex items-center gap-1 disabled:opacity-50"><Save size={14} /> {busy ? "Saving…" : dirty ? "Save" : "Saved"}</button>
            </div>
        </div>
    );
}

export default function ApplicationFormsPage() {
    const { user } = useAuth();
    return (
        <DashboardLayout>
            {user?.role === "super_admin" ? <FormsEditor /> : (
                <div className="p-8"><div className="max-w-md rounded-xl border border-amber-200 bg-amber-50 p-6">
                    <div className="flex items-center gap-2 text-amber-700 font-semibold"><ShieldAlert size={18} /> Super admin only</div>
                    <p className="mt-2 text-sm text-amber-800">Only a super admin can change the application forms.</p>
                </div></div>
            )}
        </DashboardLayout>
    );
}
