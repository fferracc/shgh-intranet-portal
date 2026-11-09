"use client";

// Announcements admin (30 Sep 2026, Franco's decisions): severity, audience and an optional
// last day; edit and delete. Rules: src/lib/announcements.ts. The UK app mirrors them.
import { useCallback, useEffect, useMemo, useState } from "react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import { RequirePermission } from "@/components/auth/RequirePermission";
import { useAuth } from "@/contexts/AuthContext";
import {
    Announcement, AnnouncementAudience, AnnouncementInput, AnnouncementSeverity, createAnnouncement, deleteAnnouncement,
    isLive, loadAnnouncements, SEVERITY_OPTIONS, SEVERITY_STYLE, shortUkDate, updateAnnouncement, visibleTo,
} from "@/lib/announcements";
import { AUDIENCE_LABEL, AUDIENCE_OPTIONS } from "@/lib/policies";
import { londonToday } from "@/lib/registers";
import { Megaphone, Trash2, Send, Pencil, X } from "lucide-react";

const SHOWN = 3;
const EMPTY: AnnouncementInput = { title: "", content: "", severity: "info", audience: "everyone", expiresAt: "" };

export default function AnnouncementsPage() {
    return (
        <DashboardLayout>
            <RequirePermission perm="announcements">
                <AnnouncementsAdmin />
            </RequirePermission>
        </DashboardLayout>
    );
}

function AnnouncementsAdmin() {
    const { user } = useAuth();
    const [items, setItems] = useState<Announcement[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState("");
    const [form, setForm] = useState<AnnouncementInput>(EMPTY);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

    const fetchItems = useCallback(async () => {
        setLoading(true);
        setLoadError("");
        try {
            setItems(await loadAnnouncements(200));
        } catch (e) {
            console.error("Fetch error", e);
            setLoadError("Announcements could not be loaded.");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchItems(); }, [fetchItems]);

    const today = londonToday();
    // Where each live announcement shows up first: the three newest live ones per audience.
    const onTop = useMemo(() => {
        const live = items.filter(a => isLive(a, today));
        const staff = new Set(live.filter(a => visibleTo(a, "staff")).slice(0, SHOWN).map(a => a.id));
        const volunteers = new Set(live.filter(a => visibleTo(a, "volunteer")).slice(0, SHOWN).map(a => a.id));
        return { staff, volunteers };
    }, [items, today]);

    const author = () => ({ uid: user?.uid || "", name: user?.displayName || user?.email || "Admin" });

    const resetForm = () => { setForm(EMPTY); setEditingId(null); };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!form.title.trim() || !form.content.trim()) { setMessage({ ok: false, text: "Please give a title and a message." }); return; }
        if (form.expiresAt && form.expiresAt < today) { setMessage({ ok: false, text: "The last day cannot be in the past." }); return; }
        setSubmitting(true);
        setMessage(null);
        try {
            if (editingId) await updateAnnouncement(editingId, form, author());
            else await createAnnouncement(form, author());
            setMessage({ ok: true, text: editingId ? "Announcement updated." : "Announcement posted." });
            resetForm();
            await fetchItems();
        } catch (err) {
            console.error(err);
            setMessage({ ok: false, text: "The announcement could not be saved." });
        } finally {
            setSubmitting(false);
        }
    };

    const startEdit = (a: Announcement) => {
        setEditingId(a.id);
        setForm({ title: a.title, content: a.content, severity: a.severity, audience: a.audience, expiresAt: a.expiresAt || "" });
        setMessage(null);
        if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
    };

    const handleDelete = async (a: Announcement) => {
        if (!confirm(`Delete "${a.title}"? It disappears from the portal and the app.`)) return;
        try {
            await deleteAnnouncement(a.id);
            if (editingId === a.id) resetForm();
            await fetchItems();
        } catch (err) {
            console.error(err);
            alert("The announcement could not be deleted.");
        }
    };

    return (
        <>
            <div className="mb-8">
                <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
                    <Megaphone className="text-blue-600" /> Announcements
                </h1>
                <p className="text-slate-500">
                    Shown on the portal dashboard and on the home screen of the UK app, to the people you choose.
                    The three newest live ones are shown first; the rest are under See all. An announcement stops showing after its last day.
                </p>
            </div>

            <div className="grid md:grid-cols-2 gap-8">
                <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-100 h-fit">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="font-bold text-lg text-slate-700">{editingId ? "Edit announcement" : "New announcement"}</h2>
                        {editingId && (
                            <button onClick={resetForm} className="text-xs text-slate-500 hover:text-slate-800 flex items-center gap-1"><X size={14} /> Cancel editing</button>
                        )}
                    </div>
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1">Title</label>
                            <input required value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} className="w-full p-2 border rounded-lg text-sm" placeholder="For example Office closed on Friday" />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1">Message</label>
                            <textarea required rows={5} value={form.content} onChange={e => setForm({ ...form, content: e.target.value })} className="w-full p-2 border rounded-lg text-sm" placeholder="The full message people will read" />
                        </div>
                        <div className="grid sm:grid-cols-2 gap-4">
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">Severity</label>
                                <select value={form.severity} onChange={e => setForm({ ...form, severity: e.target.value as AnnouncementSeverity })} className="w-full p-2 border rounded-lg text-sm bg-white">
                                    {SEVERITY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                </select>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">Who sees it</label>
                                <select value={form.audience} onChange={e => setForm({ ...form, audience: e.target.value as AnnouncementAudience })} className="w-full p-2 border rounded-lg text-sm bg-white">
                                    {AUDIENCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                </select>
                            </div>
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1">Last day shown (optional)</label>
                            <div className="flex gap-2">
                                <input type="date" min={today} value={form.expiresAt} onChange={e => setForm({ ...form, expiresAt: e.target.value })} className="flex-1 p-2 border rounded-lg text-sm" />
                                {form.expiresAt && <button type="button" onClick={() => setForm({ ...form, expiresAt: "" })} className="px-3 text-xs border rounded-lg text-slate-500">No end date</button>}
                            </div>
                            <p className="text-xs text-slate-400 mt-1">Leave empty to keep it showing until you delete it.</p>
                        </div>
                        {message && <p className={`text-sm ${message.ok ? "text-teal-700" : "text-red-600"}`}>{message.text}</p>}
                        <button type="submit" disabled={submitting} className="w-full bg-blue-600 text-white py-2 rounded-lg font-bold hover:bg-blue-700 flex items-center justify-center gap-2 disabled:opacity-50">
                            <Send size={16} /> {submitting ? "Saving…" : editingId ? "Save changes" : "Post announcement"}
                        </button>
                    </form>
                </div>

                <div className="space-y-4">
                    {loading ? (
                        <div className="text-center text-slate-400 p-8">Loading announcements…</div>
                    ) : loadError ? (
                        <div className="p-4 bg-red-50 border border-red-100 rounded-lg text-sm text-red-700">{loadError}</div>
                    ) : items.length === 0 ? (
                        <div className="text-center text-slate-400 p-8">No announcements yet.</div>
                    ) : items.map(a => {
                        const s = SEVERITY_STYLE[a.severity];
                        const live = isLive(a, today);
                        const where: string[] = [];
                        if (live && onTop.staff.has(a.id)) where.push("portal dashboard");
                        if (live && onTop.volunteers.has(a.id)) where.push("app home for volunteers");
                        return (
                            <div key={a.id} className={`bg-white p-4 rounded-xl shadow-sm border flex items-start justify-between gap-3 ${editingId === a.id ? "border-blue-300" : "border-slate-100"} ${live ? "" : "opacity-60"}`}>
                                <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2 mb-1">
                                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${s.badge}`}>{s.label}</span>
                                        <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">{AUDIENCE_LABEL[a.audience]}</span>
                                        {live ? (
                                            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-teal-50 text-teal-700">Live on dashboard/app</span>
                                        ) : (
                                            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">Expired</span>
                                        )}
                                    </div>
                                    <h3 className="font-bold text-slate-800 break-words">{a.title}</h3>
                                    <p className="text-sm text-slate-600 mt-1 whitespace-pre-line break-words">{a.content}</p>
                                    <p className="text-xs text-slate-400 mt-2">
                                        {a.createdDay ? `Posted ${shortUkDate(a.createdDay)}` : "Posted"}
                                        {a.createdBy ? ` by ${a.createdBy}` : ""}
                                        {a.expiresAt ? ` · Last day ${shortUkDate(a.expiresAt)}` : " · No end date"}
                                    </p>
                                    {live && (
                                        <p className="text-xs text-slate-400 mt-1">
                                            {where.length > 0 ? `Shown first on the ${where.join(" and the ")}.` : "Live, listed under See all."}
                                        </p>
                                    )}
                                </div>
                                <div className="flex flex-col gap-1">
                                    <button onClick={() => startEdit(a)} className="text-slate-400 hover:text-blue-600 p-2" title="Edit"><Pencil size={16} /></button>
                                    <button onClick={() => handleDelete(a)} className="text-red-400 hover:text-red-600 p-2" title="Delete"><Trash2 size={16} /></button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </>
    );
}
