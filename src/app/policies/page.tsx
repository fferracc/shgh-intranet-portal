"use client";

// Policy Hub (30 Sep 2026, Franco's decisions). Rules live in src/lib/policies.ts:
// audience (staff / volunteers / everyone), versions (a new version must be read again),
// "Mark as Read" only after the document has been opened, and admin figures that can
// never pass 100%. The UK app mirrors these rules.
import DashboardLayout from "@/components/layout/DashboardLayout";
import { useAuth } from "@/contexts/AuthContext";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
    AUDIENCE_LABEL, AUDIENCE_OPTIONS, canManagePolicies, createPolicy, deletePolicy, GroupCount, isHttpUrl,
    loadPolicies, loadPolicyPeople, loadReadMap, markPolicyRead, mustRead, pct, PolicyAudience, PolicyDoc,
    PolicyInput, PolicyPerson, policyStats, ReadMap, readCounts, readRecordOf, updatePolicy, uploadNewVersion,
} from "@/lib/policies";
import { ukDate } from "@/lib/registers";
import { FileText, CheckCircle, ExternalLink, Plus, Pencil, Trash2, Upload, ChevronDown, ChevronUp, X, AlertTriangle, RefreshCw } from "lucide-react";

type ModalState =
    | null
    | { kind: "add" }
    | { kind: "edit"; policy: PolicyDoc }
    | { kind: "version"; policy: PolicyDoc }
    | { kind: "text"; policy: PolicyDoc };

const openKey = (p: PolicyDoc) => `${p.id}:v${p.version}`;

const AUDIENCE_BADGE: Record<PolicyAudience, string> = {
    everyone: "bg-slate-100 text-slate-600",
    staff: "bg-indigo-50 text-indigo-700",
    volunteers: "bg-emerald-50 text-emerald-700",
};

function percentText(c: GroupCount): string {
    const p = pct(c);
    return p === null ? "No one to read" : `${p}%`;
}

export default function PoliciesPage() {
    const { user } = useAuth();
    const manager = canManagePolicies(user);

    const [policies, setPolicies] = useState<PolicyDoc[]>([]);
    const [reads, setReads] = useState<ReadMap>(new Map());
    const [people, setPeople] = useState<PolicyPerson[]>([]);
    const [partial, setPartial] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    /** Documents opened on this page: `${id}:v${version}` -> when (ISO). */
    const [opened, setOpened] = useState<Record<string, string>>({});
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});
    const [modal, setModal] = useState<ModalState>(null);
    const [markingId, setMarkingId] = useState<string | null>(null);

    const load = useCallback(async () => {
        if (!user?.uid) return;
        setLoading(true);
        setError("");
        try {
            const [pols, readResult, ppl] = await Promise.all([
                loadPolicies(),
                loadReadMap(manager ? undefined : user.uid),
                manager ? loadPolicyPeople() : Promise.resolve([] as PolicyPerson[]),
            ]);
            setPolicies(pols);
            setReads(readResult.map);
            setPartial(readResult.partial);
            setPeople(ppl);
        } catch (e: any) {
            console.error("Error loading policies:", e);
            setError("The policies could not be loaded. Please refresh the page.");
        } finally {
            setLoading(false);
        }
    }, [user?.uid, manager]);

    useEffect(() => { load(); }, [load]);

    // Staff see staff and everyone policies. Admins see every policy so they can manage them.
    const visible = useMemo(
        () => (manager ? policies : policies.filter(p => mustRead(p, user?.role))),
        [policies, manager, user?.role]
    );

    const stats = useMemo(() => (manager ? policyStats(policies, people, reads) : null), [manager, policies, people, reads]);

    const mine = useMemo(() => {
        if (!user) return { read: 0, total: 0 };
        const required = policies.filter(p => mustRead(p, user.role));
        const read = required.filter(p => readCounts(readRecordOf(reads, user.uid, p.id), p)).length;
        return { read, total: required.length };
    }, [policies, reads, user]);
    const myProgress = mine.total > 0 ? Math.min(100, Math.round((mine.read / mine.total) * 100)) : 100;

    const handleOpen = (p: PolicyDoc) => {
        if (p.isUrl) window.open(p.link, "_blank", "noopener,noreferrer");
        else setModal({ kind: "text", policy: p });
        setOpened(prev => (prev[openKey(p)] ? prev : { ...prev, [openKey(p)]: new Date().toISOString() }));
    };

    const handleMarkAsRead = async (p: PolicyDoc) => {
        if (!user) return;
        const openedAt = opened[openKey(p)];
        if (!openedAt) return;
        setMarkingId(p.id);
        try {
            await markPolicyRead(user.uid, p, openedAt);
            setReads(prev => {
                const next: ReadMap = new Map(prev);
                const mineMap = new Map(next.get(user.uid) || []);
                mineMap.set(p.id, { userId: user.uid, policyId: p.id, version: p.version, source: "portal" });
                next.set(user.uid, mineMap);
                return next;
            });
        } catch (e) {
            console.error("Error marking as read:", e);
            alert("Your reading could not be saved. Please try again.");
        } finally {
            setMarkingId(null);
        }
    };

    const handleDelete = async (p: PolicyDoc) => {
        if (!confirm(`Delete "${p.title}"? It disappears from the portal and the app. Past reads are kept but no longer count.`)) return;
        try {
            await deletePolicy(p.id);
            await load();
        } catch (e) {
            console.error(e);
            alert("The policy could not be deleted.");
        }
    };

    return (
        <DashboardLayout>
            <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-slate-800">Policy Hub</h1>
                    <p className="text-slate-500">Open each policy, read it, then mark it as read.</p>
                </div>
                {manager && (
                    <div className="flex gap-2">
                        <button onClick={load} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-600 hover:bg-slate-50">
                            <RefreshCw size={16} /> Refresh
                        </button>
                        <button onClick={() => setModal({ kind: "add" })} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700">
                            <Plus size={16} /> Add policy
                        </button>
                    </div>
                )}
            </div>

            {manager && stats && !loading && !error && (
                <div className="mb-8">
                    <div className="grid sm:grid-cols-3 gap-4">
                        {([
                            ["Staff", stats.totals.staff],
                            ["Volunteers", stats.totals.volunteers],
                            ["Everyone", stats.totals.all],
                        ] as [string, GroupCount][]).map(([label, c]) => (
                            <div key={label} className="bg-white p-5 rounded-xl shadow-sm border border-slate-100">
                                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</p>
                                <p className="text-3xl font-bold text-slate-800 mt-1">{pct(c) === null ? "None" : `${pct(c)}%`}</p>
                                <p className="text-xs text-slate-500 mt-1">{c.read} of {c.total} required reads done</p>
                                <div className="mt-3 h-2 rounded bg-slate-100 overflow-hidden">
                                    <div className="h-2 bg-blue-500" style={{ width: `${pct(c) ?? 0}%` }} />
                                </div>
                            </div>
                        ))}
                    </div>
                    {partial && (
                        <p className="mt-3 text-xs text-amber-700 flex items-center gap-1">
                            <AlertTriangle size={14} /> Some reading records could not be loaded, so these figures may be low.
                        </p>
                    )}
                </div>
            )}

            <div className="grid md:grid-cols-3 gap-8">
                <div className="md:col-span-2 space-y-4">
                    {loading ? (
                        <div className="p-8 text-center text-slate-500">Loading policies…</div>
                    ) : error ? (
                        <div className="p-6 bg-red-50 border border-red-100 rounded-xl text-red-700 text-sm">{error}</div>
                    ) : visible.length === 0 ? (
                        <div className="text-center p-8 bg-white rounded-xl border border-slate-100 text-slate-400">No policies yet.</div>
                    ) : (
                        visible.map(p => {
                            const required = !!user && mustRead(p, user.role);
                            const rec = user ? readRecordOf(reads, user.uid, p.id) : undefined;
                            const isRead = readCounts(rec, p);
                            const readAgain = !!rec && !isRead;
                            const hasOpened = !!opened[openKey(p)];
                            const s = stats?.byPolicy[p.id];
                            const isOpen = !!expanded[p.id];
                            return (
                                <div key={p.id} className="bg-white p-6 rounded-xl shadow-sm border border-slate-100 hover:border-blue-200 transition-colors">
                                    <div className="flex flex-wrap items-start justify-between gap-4">
                                        <div className="flex items-start gap-4 min-w-0">
                                            <div className={`p-3 rounded-lg ${isRead ? "bg-teal-50 text-teal-600" : "bg-blue-50 text-blue-600"}`}>
                                                <FileText size={24} />
                                            </div>
                                            <div className="min-w-0">
                                                <h3 className="font-semibold text-slate-900">{p.title}</h3>
                                                <div className="flex flex-wrap items-center gap-2 mt-1">
                                                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${AUDIENCE_BADGE[p.audience]}`}>{AUDIENCE_LABEL[p.audience]}</span>
                                                    {p.category && <span className="text-xs px-2 py-0.5 rounded-full bg-slate-50 text-slate-500 border border-slate-100">{p.category}</span>}
                                                    <span className="text-xs text-slate-400">
                                                        Version {p.version}
                                                        {p.createdDay ? ` · Published ${ukDate(p.createdDay)}` : ""}
                                                        {p.updatedDay && p.updatedDay !== p.createdDay ? ` · Updated ${ukDate(p.updatedDay)}` : ""}
                                                    </span>
                                                </div>
                                                {p.versionNote && p.version > 1 && (
                                                    <p className="text-xs text-slate-500 mt-1">What changed: {p.versionNote}</p>
                                                )}
                                                {readAgain && (
                                                    <p className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-amber-700 bg-amber-50 px-2 py-1 rounded">
                                                        <AlertTriangle size={12} /> New version: please read again
                                                    </p>
                                                )}
                                                {!required && manager && (
                                                    <p className="text-xs text-slate-400 mt-1">For volunteers: you do not need to read this one.</p>
                                                )}
                                            </div>
                                        </div>

                                        <div className="flex items-center gap-2">
                                            {required && (isRead ? (
                                                <span className="flex items-center gap-1.5 text-xs font-medium text-teal-600 bg-teal-50 px-3 py-1.5 rounded-full">
                                                    <CheckCircle size={14} /> Read
                                                </span>
                                            ) : hasOpened ? (
                                                <button
                                                    onClick={() => handleMarkAsRead(p)}
                                                    disabled={markingId === p.id}
                                                    className="text-xs font-semibold text-white bg-teal-600 hover:bg-teal-700 px-3 py-1.5 rounded-full disabled:opacity-50"
                                                >
                                                    {markingId === p.id ? "Saving…" : "Mark as Read"}
                                                </button>
                                            ) : (
                                                <span className="text-xs text-slate-400">Open it to mark as read</span>
                                            ))}
                                            <button
                                                onClick={() => handleOpen(p)}
                                                disabled={!p.link}
                                                className="flex items-center gap-1.5 text-xs font-medium text-blue-700 border border-blue-200 hover:bg-blue-50 px-3 py-1.5 rounded-full disabled:opacity-40"
                                                title="Open the document"
                                            >
                                                <ExternalLink size={14} /> Open
                                            </button>
                                        </div>
                                    </div>

                                    {manager && (
                                        <div className="mt-4 pt-4 border-t border-slate-100">
                                            {s && (
                                                <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                                                    {p.audience !== "volunteers" && (
                                                        <span className="text-slate-600">Staff: <strong>{s.staff.read} of {s.staff.total}</strong> read <span className="text-slate-400">({percentText(s.staff)})</span></span>
                                                    )}
                                                    {p.audience !== "staff" && (
                                                        <span className="text-slate-600">Volunteers: <strong>{s.volunteers.read} of {s.volunteers.total}</strong> read <span className="text-slate-400">({percentText(s.volunteers)})</span></span>
                                                    )}
                                                    <span className="text-slate-600">Overall: <strong>{percentText(s.all)}</strong></span>
                                                </div>
                                            )}
                                            <div className="mt-3 flex flex-wrap items-center gap-2">
                                                {s && s.notRead.length > 0 && (
                                                    <button onClick={() => setExpanded(prev => ({ ...prev, [p.id]: !isOpen }))} className="flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900 px-2 py-1 rounded border border-slate-200">
                                                        {isOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />} Not read yet ({s.notRead.length})
                                                    </button>
                                                )}
                                                <span className="flex-1" />
                                                <button onClick={() => setModal({ kind: "edit", policy: p })} className="flex items-center gap-1 text-xs text-slate-600 hover:text-blue-700 px-2 py-1 rounded hover:bg-blue-50">
                                                    <Pencil size={14} /> Edit
                                                </button>
                                                <button onClick={() => setModal({ kind: "version", policy: p })} className="flex items-center gap-1 text-xs text-slate-600 hover:text-blue-700 px-2 py-1 rounded hover:bg-blue-50">
                                                    <Upload size={14} /> Upload new version
                                                </button>
                                                <button onClick={() => handleDelete(p)} className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50">
                                                    <Trash2 size={14} /> Delete
                                                </button>
                                            </div>
                                            {isOpen && s && (
                                                <div className="mt-3 grid sm:grid-cols-2 gap-4">
                                                    {(["staff", "volunteers"] as const).map(g => {
                                                        const list = s.notRead.filter(x => x.group === g);
                                                        if (list.length === 0) return null;
                                                        return (
                                                            <div key={g}>
                                                                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1">{g === "staff" ? "Staff" : "Volunteers"} ({list.length})</p>
                                                                <ul className="text-sm text-slate-700 max-h-48 overflow-y-auto space-y-0.5">
                                                                    {list.map(x => <li key={x.uid}>{x.name}</li>)}
                                                                </ul>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })
                    )}
                </div>

                <div className="space-y-6">
                    <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-100">
                        <h3 className="font-semibold text-slate-800 mb-4">Your reading</h3>
                        <div className="flex mb-2 items-center justify-between">
                            <span className="text-xs font-semibold py-1 px-2 uppercase rounded-full text-blue-600 bg-blue-100">Progress</span>
                            <span className="text-xs font-semibold text-blue-600">{loading ? "…" : `${myProgress}%`}</span>
                        </div>
                        <div className="overflow-hidden h-2 mb-4 flex rounded bg-blue-100">
                            <div style={{ width: `${loading ? 0 : myProgress}%` }} className="bg-blue-500 transition-all duration-500" />
                        </div>
                        <p className="text-sm text-slate-500">
                            You have read <strong>{mine.read}</strong> of the <strong>{mine.total}</strong> policies you need to read.
                        </p>
                    </div>
                </div>
            </div>

            {modal?.kind === "text" && (
                <Modal title={modal.policy.title} onClose={() => setModal(null)}>
                    <p className="text-sm text-slate-700 whitespace-pre-line">{modal.policy.link}</p>
                </Modal>
            )}
            {(modal?.kind === "add" || modal?.kind === "edit") && user && (
                <PolicyForm
                    policy={modal.kind === "edit" ? modal.policy : undefined}
                    onClose={() => setModal(null)}
                    onSave={async input => {
                        if (modal.kind === "edit") await updatePolicy(modal.policy.id, input, user.uid);
                        else await createPolicy(input, user.uid);
                        setModal(null);
                        await load();
                    }}
                />
            )}
            {modal?.kind === "version" && user && (
                <VersionForm
                    policy={modal.policy}
                    onClose={() => setModal(null)}
                    onSave={async (link, note) => {
                        await uploadNewVersion(modal.policy, link, note, user.uid);
                        setModal(null);
                        await load();
                    }}
                />
            )}
        </DashboardLayout>
    );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
    return (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
            <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
                <div className="flex items-start justify-between gap-4 mb-4">
                    <h2 className="text-lg font-bold text-slate-800">{title}</h2>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="Close"><X size={20} /></button>
                </div>
                {children}
            </div>
        </div>
    );
}

function PolicyForm({ policy, onClose, onSave }: { policy?: PolicyDoc; onClose: () => void; onSave: (input: PolicyInput) => Promise<void> }) {
    const [form, setForm] = useState<PolicyInput>({
        title: policy?.title || "",
        link: policy?.link || "",
        category: policy?.category || "",
        audience: policy?.audience || "everyone",
    });
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState("");

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!form.title.trim() || !form.link.trim()) { setErr("Please give a title and a document link."); return; }
        // Some old app entries hold plain text instead of a link; they may be edited as they are.
        if ((!policy || form.link !== policy.link) && !isHttpUrl(form.link)) { setErr("The document link must start with https://"); return; }
        setSaving(true);
        setErr("");
        try { await onSave(form); }
        catch (e) { console.error(e); setErr("The policy could not be saved. Only admins can manage policies."); setSaving(false); }
    };

    return (
        <Modal title={policy ? "Edit policy" : "Add policy"} onClose={onClose}>
            <form onSubmit={submit} className="space-y-4">
                <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Title</label>
                    <input required value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} className="w-full p-2 border rounded-lg text-sm" placeholder="For example Safeguarding Policy" />
                </div>
                <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Document link</label>
                    <input required value={form.link} onChange={e => setForm({ ...form, link: e.target.value })} className="w-full p-2 border rounded-lg text-sm" placeholder="https://drive.google.com/…" />
                    {policy && <p className="text-xs text-slate-400 mt-1">Fixing the link keeps the same version. To publish a changed document, use Upload new version.</p>}
                </div>
                <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Category (optional)</label>
                    <input value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} className="w-full p-2 border rounded-lg text-sm" placeholder="For example Safeguarding" />
                </div>
                <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Who must read it</label>
                    <select value={form.audience} onChange={e => setForm({ ...form, audience: e.target.value as PolicyAudience })} className="w-full p-2 border rounded-lg text-sm bg-white">
                        {AUDIENCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                </div>
                {err && <p className="text-sm text-red-600">{err}</p>}
                <div className="flex justify-end gap-2">
                    <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-200 text-sm">Cancel</button>
                    <button type="submit" disabled={saving} className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-50">{saving ? "Saving…" : "Save"}</button>
                </div>
            </form>
        </Modal>
    );
}

function VersionForm({ policy, onClose, onSave }: { policy: PolicyDoc; onClose: () => void; onSave: (link: string, note: string) => Promise<void> }) {
    const [link, setLink] = useState("");
    const [note, setNote] = useState("");
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState("");

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!isHttpUrl(link)) { setErr("The new document link must start with https://"); return; }
        setSaving(true);
        setErr("");
        try { await onSave(link, note); }
        catch (e) { console.error(e); setErr("The new version could not be saved. Only admins can manage policies."); setSaving(false); }
    };

    return (
        <Modal title={`New version of ${policy.title}`} onClose={onClose}>
            <form onSubmit={submit} className="space-y-4">
                <div className="p-3 rounded-lg bg-amber-50 border border-amber-100 text-sm text-amber-800">
                    This replaces the document and makes it version {policy.version + 1}. Everyone who must read it will have to read it again.
                </div>
                <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">New document link</label>
                    <input required value={link} onChange={e => setLink(e.target.value)} className="w-full p-2 border rounded-lg text-sm" placeholder="https://drive.google.com/…" />
                    <p className="text-xs text-slate-400 mt-1">Current link: <span className="break-all">{policy.link || "none"}</span></p>
                </div>
                <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">What changed (optional)</label>
                    <textarea rows={3} value={note} onChange={e => setNote(e.target.value)} className="w-full p-2 border rounded-lg text-sm" placeholder="For example Updated contact details for the safeguarding lead" />
                </div>
                {err && <p className="text-sm text-red-600">{err}</p>}
                <div className="flex justify-end gap-2">
                    <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-200 text-sm">Cancel</button>
                    <button type="submit" disabled={saving} className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-50">{saving ? "Saving…" : `Publish version ${policy.version + 1}`}</button>
                </div>
            </form>
        </Modal>
    );
}
