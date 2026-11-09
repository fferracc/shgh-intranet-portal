"use client";

import DashboardLayout from "@/components/layout/DashboardLayout";
import { useEffect, useMemo, useState } from "react";
import { collection, getDocs, addDoc, updateDoc, doc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "@/lib/firebase";
import { Award, Plus, Archive, ArchiveRestore, X, Pencil, RefreshCw, HandHeart, Users, Info } from "lucide-react";
import { setBadgeArchived } from "@/lib/archive";
import { useAuth } from "@/contexts/AuthContext";
import { Badge, EarnedBadge } from "@/lib/types";
import { RequirePermission } from "@/components/auth/RequirePermission";
import { BADGE_TYPE_OPTIONS, badgeAmount, badgeTypeLabel, earnedDay, isAutoBadge, isAutoType, isHandAward, ukDate } from "@/lib/badges";

// Badges (rebuilt 30 Sep 2026). The server awards automatic badges (functions/index.js, BADGES)
// with the date the target was really reached; this page only defines badges, shows who has
// them, asks the server to recheck everyone and awards badges by hand. See src/lib/badges.ts.

const CATEGORIES = ["Skill", "Attendance", "Community", "Leadership"];

interface Person { uid: string; name: string; role: string; archived: boolean }
interface RecheckResult { checked: number; total?: number; awarded: { name: string; archived?: boolean; badges: string[] }[] }

type FormState = { name: string; description: string; iconUrl: string; category: string; type: string; goal: string };
const emptyForm: FormState = { name: "", description: "", iconUrl: "", category: "Skill", type: "classCount", goal: "" };

const errText = (e: any, fallback: string) => {
    const code = String(e?.code || "");
    if (code.startsWith("functions/") && e?.message && code !== "functions/internal") return String(e.message);
    return fallback;
};

function BadgesPage() {
    const { user } = useAuth();
    const isSuper = user?.role === "super_admin";
    const [badges, setBadges] = useState<Badge[]>([]);
    const [earned, setEarned] = useState<EarnedBadge[]>([]);
    const [people, setPeople] = useState<Person[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState("");
    const [showArchived, setShowArchived] = useState(false);
    const [showHelp, setShowHelp] = useState(false);

    // Create or edit
    const [editing, setEditing] = useState<Badge | null>(null);
    const [formOpen, setFormOpen] = useState(false);
    const [form, setForm] = useState<FormState>(emptyForm);
    const [formError, setFormError] = useState("");
    const [saving, setSaving] = useState(false);

    // Who has a badge
    const [whoFor, setWhoFor] = useState<Badge | null>(null);
    const [withdrawing, setWithdrawing] = useState("");

    // Recheck
    const [rechecking, setRechecking] = useState(false);
    const [recheck, setRecheck] = useState<RecheckResult | null>(null);
    const [recheckError, setRecheckError] = useState("");

    // Award by hand
    const [awardOpen, setAwardOpen] = useState(false);
    const [award, setAward] = useState({ search: "", uid: "", badgeId: "", reason: "" });
    const [awardError, setAwardError] = useState("");
    const [awarding, setAwarding] = useState(false);
    const [note, setNote] = useState("");

    const loadEarned = async () => {
        const snap = await getDocs(collection(db, "earnedAchievements"));
        setEarned(snap.docs.map(d => ({ id: d.id, ...d.data() } as EarnedBadge)));
    };

    useEffect(() => {
        const load = async () => {
            try {
                const [badgeSnap, userSnap] = await Promise.all([
                    getDocs(collection(db, "achievementsBadges")),
                    getDocs(collection(db, "users")),
                ]);
                setBadges(badgeSnap.docs.map(d => ({ id: d.id, ...d.data() } as Badge)));
                setPeople(userSnap.docs.map(d => {
                    const u = d.data();
                    return { uid: d.id, name: String(u.displayName || u.name || u.email || d.id), role: String(u.role || ""), archived: u.archived === true };
                }).sort((a, b) => a.name.localeCompare(b.name, "en-GB")));
                await loadEarned();
            } catch (e) {
                console.error("Error loading badges:", e);
                setLoadError("The badges could not be loaded. Please refresh the page.");
            } finally {
                setLoading(false);
            }
        };
        load();
    }, []);

    const personName = useMemo(() => new Map(people.map(p => [p.uid, p.name])), [people]);
    // Distinct people per badge (older data may hold the same badge twice for one person).
    const holders = useMemo(() => {
        const m = new Map<string, EarnedBadge[]>();
        const seen = new Set<string>();
        [...earned].sort((a, b) => earnedDay(a).localeCompare(earnedDay(b))).forEach(e => {
            const k = `${e.volunteerId}|${e.badgeId}`;
            if (!e.volunteerId || !e.badgeId || seen.has(k)) return;
            seen.add(k);
            if (!m.has(e.badgeId)) m.set(e.badgeId, []);
            m.get(e.badgeId)!.push(e);
        });
        return m;
    }, [earned]);

    // ------------------------------------------------ create and edit
    const openCreate = () => { setEditing(null); setForm(emptyForm); setFormError(""); setFormOpen(true); };
    const openEdit = (b: Badge) => {
        setEditing(b);
        setForm({
            name: b.name || "", description: b.description || "", iconUrl: b.iconUrl || "", category: b.category || "Skill",
            type: isAutoType(b.type) ? String(b.type) : "Manual", goal: isAutoType(b.type) && b.goal ? String(b.goal) : "",
        });
        setFormError("");
        setFormOpen(true);
    };

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        const name = form.name.trim();
        if (!name) { setFormError("Please enter a name."); return; }
        const auto = form.type !== "Manual";
        const goal = Number(form.goal);
        if (auto && (!isFinite(goal) || goal <= 0)) { setFormError("Please enter a target above 0."); return; }
        if (auto && form.type !== "hours" && !Number.isInteger(goal)) { setFormError("The target must be a whole number."); return; }
        const data = {
            name, description: form.description.trim(), iconUrl: form.iconUrl.trim(), category: form.category,
            type: auto ? form.type : "Manual", goal: auto ? goal : null,
        };
        setSaving(true);
        setFormError("");
        try {
            if (editing) {
                await updateDoc(doc(db, "achievementsBadges", editing.id), data);
                setBadges(prev => prev.map(b => b.id === editing.id ? { ...b, ...data } : b));
            } else {
                const ref = await addDoc(collection(db, "achievementsBadges"), data);
                setBadges(prev => [...prev, { id: ref.id, ...data } as Badge]);
            }
            setFormOpen(false);
            setNote(auto ? "Badge saved. Press Recheck everyone now to give it to people who have already reached the target." : "Badge saved.");
        } catch (error) {
            console.error("Error saving badge:", error);
            setFormError("The badge was not saved. You need the Badges permission.");
        } finally {
            setSaving(false);
        }
    };

    // Keep history (30 Sep 2026): a badge is archived, never deleted. It is no longer
    // awarded, and people who earned it keep it on their profile and in reports.
    const handleArchive = async (badge: Badge, archived: boolean) => {
        if (archived && !confirm(`Archive the badge "${badge.name}"?\n\nIt will no longer be awarded. People who already earned it keep it. You can restore it later.`)) return;
        try {
            await setBadgeArchived(badge.id, archived, user?.uid || "");
            setBadges(prev => prev.map(b => b.id === badge.id ? { ...b, archived } : b));
        } catch (error) {
            console.error("Error archiving badge:", error);
            alert("The badge could not be changed. You need the Badges permission.");
        }
    };

    // ------------------------------------------------ recheck
    const runRecheck = async () => {
        setRechecking(true);
        setRecheckError("");
        setRecheck(null);
        try {
            const res = await httpsCallable(functions, "recheckAllBadges", { timeout: 540000 })({});
            setRecheck(res.data as RecheckResult);
            await loadEarned();
        } catch (e) {
            console.error("Recheck failed:", e);
            setRecheckError(errText(e, "The recheck did not finish. Please try again in a minute."));
        } finally {
            setRechecking(false);
        }
    };

    // ------------------------------------------------ award by hand
    const openAward = (badgeId = "") => { setAward({ search: "", uid: "", badgeId, reason: "" }); setAwardError(""); setAwardOpen(true); };
    const hasBadge = (uid: string, badgeId: string) => (holders.get(badgeId) || []).some(e => e.volunteerId === uid);
    const handleAward = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!award.uid || !award.badgeId) { setAwardError("Please choose a person and a badge."); return; }
        if (hasBadge(award.uid, award.badgeId)) { setAwardError("This person already has this badge."); return; }
        setAwarding(true);
        setAwardError("");
        try {
            await httpsCallable(functions, "awardBadgeByHand")({ uid: award.uid, badgeId: award.badgeId, reason: award.reason.trim() });
            await loadEarned();
            setAwardOpen(false);
            const b = badges.find(x => x.id === award.badgeId);
            setNote(`${b?.name || "The badge"} was awarded to ${personName.get(award.uid) || "the person"}.`);
        } catch (err) {
            console.error("Award failed:", err);
            setAwardError(errText(err, "The badge was not awarded. Please try again."));
        } finally {
            setAwarding(false);
        }
    };

    const handleWithdraw = async (e: EarnedBadge, badge: Badge) => {
        const who = personName.get(e.volunteerId) || "this person";
        if (!confirm(`Withdraw "${badge.name}" from ${who}?\n\nOnly do this to fix a mistake. The badge disappears from their profile. A record of the award is kept.`)) return;
        setWithdrawing(e.id);
        try {
            await httpsCallable(functions, "withdrawHandBadge")({ earnedId: e.id });
            setEarned(prev => prev.filter(x => x.id !== e.id));
        } catch (err) {
            console.error("Withdraw failed:", err);
            alert(errText(err, "The badge was not withdrawn. Please try again."));
        } finally {
            setWithdrawing("");
        }
    };

    const archivedCount = badges.filter(b => b.archived === true).length;
    const shown = badges.filter(b => showArchived ? b.archived === true : b.archived !== true)
        .sort((a, b) => (a.name || "").localeCompare(b.name || "", "en-GB"));
    const awardPeople = people.filter(p => !p.archived && (!award.search.trim() || p.name.toLowerCase().includes(award.search.trim().toLowerCase())));
    const awardBadges = badges.filter(b => b.archived !== true).sort((a, b) => (a.name || "").localeCompare(b.name || "", "en-GB"));
    const btn = "px-4 py-2 rounded-lg flex items-center gap-2 transition text-sm font-semibold disabled:opacity-50";

    return (
        <DashboardLayout>
            <div className="flex flex-wrap justify-between items-start gap-4 mb-6">
                <div>
                    <h1 className="text-2xl font-bold text-slate-800">Badge Management</h1>
                    <p className="text-slate-500">Badges for volunteers and staff. Automatic badges are given by the system on the day the target was reached.</p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <button onClick={runRecheck} disabled={rechecking || loading} className={`${btn} bg-white border border-slate-200 text-slate-700 hover:bg-slate-50`}>
                        <RefreshCw size={16} className={rechecking ? "animate-spin" : ""} /> {rechecking ? "Checking everyone…" : "Recheck everyone now"}
                    </button>
                    <button onClick={() => openAward()} disabled={loading} className={`${btn} bg-white border border-slate-200 text-slate-700 hover:bg-slate-50`}>
                        <HandHeart size={16} /> Award by hand
                    </button>
                    <button onClick={openCreate} className={`${btn} bg-purple-600 text-white hover:bg-purple-700`}>
                        <Plus size={16} /> New badge
                    </button>
                </div>
            </div>

            {note && (
                <div role="status" className="mb-4 p-3 rounded-lg bg-green-50 border border-green-200 text-sm text-green-800 flex justify-between gap-4">
                    <span>{note}</span>
                    <button onClick={() => setNote("")} aria-label="Close"><X size={16} /></button>
                </div>
            )}
            {recheckError && <div role="alert" className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">{recheckError}</div>}

            <div className="mb-6">
                <button onClick={() => setShowHelp(v => !v)} className="text-sm text-purple-700 hover:underline flex items-center gap-1">
                    <Info size={14} /> {showHelp ? "Hide" : "How"} badges are counted
                </button>
                {showHelp && (
                    <div className="mt-2 p-4 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-600 space-y-2">
                        {BADGE_TYPE_OPTIONS.map(o => <p key={o.value}><span className="font-semibold text-slate-800">{o.label}.</span> {o.help}</p>)}
                        <p>The system checks a person when a register or 1-2-1 session is saved or hours are approved, and checks everyone every night at 3am. The date shown is the day the target was reached, also for badges given later. A badge that has been earned is never taken away. Archived badges are no longer given.</p>
                    </div>
                )}
            </div>

            <label className="flex items-center gap-2 text-sm text-slate-600 mb-4 cursor-pointer">
                <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} className="w-4 h-4" />
                Show archived badges ({archivedCount})
            </label>

            {loading ? (
                <p className="text-slate-400 py-8 text-center">Loading badges…</p>
            ) : loadError ? (
                <p role="alert" className="text-red-600 py-8 text-center">{loadError}</p>
            ) : shown.length === 0 ? (
                <p className="text-slate-400 py-8 text-center">{showArchived ? "No archived badges." : "No badges yet. Create the first one with New badge."}</p>
            ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                    {shown.map(badge => {
                        const n = (holders.get(badge.id) || []).length;
                        return (
                            <div key={badge.id} className="bg-white p-6 rounded-xl shadow-sm border border-slate-100 flex flex-col items-center text-center relative">
                                <div className="absolute top-2 right-2 flex gap-1">
                                    <button onClick={() => openEdit(badge)} className="p-1 text-slate-400 hover:text-purple-700" title="Edit badge" aria-label="Edit badge"><Pencil size={16} /></button>
                                    {badge.archived === true ? (
                                        <button onClick={() => handleArchive(badge, false)} className="p-1 text-slate-400 hover:text-green-700" title="Restore badge" aria-label="Restore badge"><ArchiveRestore size={16} /></button>
                                    ) : (
                                        <button onClick={() => handleArchive(badge, true)} className="p-1 text-slate-400 hover:text-red-500" title="Archive badge (people keep it)" aria-label="Archive badge"><Archive size={16} /></button>
                                    )}
                                </div>
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={badge.iconUrl || "https://placehold.co/100x100?text=Badge"} alt="" className="w-16 h-16 rounded-full mb-3 object-cover bg-slate-50" />
                                <h3 className="font-bold text-slate-800">{badge.name}</h3>
                                {badge.category && <span className="text-xs font-semibold text-purple-600 bg-purple-50 px-2 py-0.5 rounded-full mb-2">{badge.category}</span>}
                                <p className="text-xs text-slate-500 mb-3">{badge.description}</p>
                                <p className="text-xs text-slate-700 mt-auto">
                                    {isAutoBadge(badge) ? <>{badgeTypeLabel(badge.type)}: <span className="font-semibold">{badgeAmount(badge.type, Number(badge.goal))}</span></> : "By hand only"}
                                </p>
                                <button onClick={() => setWhoFor(badge)} className="mt-2 text-xs font-semibold text-purple-700 hover:underline flex items-center gap-1">
                                    <Users size={12} /> Earned by {n} {n === 1 ? "person" : "people"}
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Create or edit */}
            {formOpen && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6 max-h-[90vh] overflow-y-auto">
                        <div className="flex justify-between items-center mb-4">
                            <h3 className="font-bold text-xl text-slate-800">{editing ? "Edit badge" : "New badge"}</h3>
                            <button onClick={() => setFormOpen(false)} aria-label="Close"><X size={24} className="text-slate-400" /></button>
                        </div>
                        <form onSubmit={handleSave} className="space-y-3">
                            <label className="block text-sm font-semibold text-slate-700">Name
                                <input required className="mt-1 w-full p-2 border rounded font-normal" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
                            </label>
                            <label className="block text-sm font-semibold text-slate-700">Description
                                <textarea className="mt-1 w-full p-2 border rounded font-normal" rows={2} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
                            </label>
                            <label className="block text-sm font-semibold text-slate-700">Icon URL
                                <input placeholder="https://..." className="mt-1 w-full p-2 border rounded font-normal" value={form.iconUrl} onChange={e => setForm({ ...form, iconUrl: e.target.value })} />
                            </label>
                            <label className="block text-sm font-semibold text-slate-700">Category
                                <select className="mt-1 w-full p-2 border rounded font-normal" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
                                    {[...CATEGORIES, ...(CATEGORIES.includes(form.category) ? [] : [form.category])].map(c => <option key={c}>{c}</option>)}
                                </select>
                            </label>
                            <label className="block text-sm font-semibold text-slate-700">Earned by
                                <select className="mt-1 w-full p-2 border rounded font-normal" value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}>
                                    {BADGE_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                </select>
                                <span className="block mt-1 text-xs font-normal text-slate-500">{BADGE_TYPE_OPTIONS.find(o => o.value === form.type)?.help}</span>
                            </label>
                            {form.type !== "Manual" && (
                                <label className="block text-sm font-semibold text-slate-700">Target
                                    <input type="number" min={form.type === "hours" ? 0.5 : 1} step={form.type === "hours" ? 0.5 : 1} required className="mt-1 w-full p-2 border rounded font-normal" value={form.goal} onChange={e => setForm({ ...form, goal: e.target.value })} />
                                    <span className="block mt-1 text-xs font-normal text-slate-500">
                                        {form.type === "classCount" ? "Number of classes." : form.type === "hours" ? "Number of hours." : form.type === "monthsOfService" ? "Number of whole months." : "Number of different courses."}
                                    </span>
                                </label>
                            )}
                            {editing && isAutoBadge(editing) && <p className="text-xs text-slate-500">Changing the target does not take the badge away from people who already have it.</p>}
                            {formError && <p role="alert" className="text-sm text-red-600">{formError}</p>}
                            <button type="submit" disabled={saving} className="w-full bg-purple-600 text-white py-2 rounded-lg font-bold disabled:opacity-50">{saving ? "Saving…" : editing ? "Save changes" : "Create badge"}</button>
                        </form>
                    </div>
                </div>
            )}

            {/* Who has it */}
            {whoFor && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
                        <div className="flex justify-between items-center mb-4">
                            <h3 className="font-bold text-xl text-slate-800 flex items-center gap-2"><Award className="text-yellow-500" size={20} /> {whoFor.name}</h3>
                            <button onClick={() => setWhoFor(null)} aria-label="Close"><X size={24} className="text-slate-400" /></button>
                        </div>
                        {(holders.get(whoFor.id) || []).length === 0 ? (
                            <p className="text-sm text-slate-400">Nobody has this badge yet.</p>
                        ) : (
                            <ul className="divide-y divide-slate-100">
                                {(holders.get(whoFor.id) || []).map(e => (
                                    <li key={e.id} className="py-2 flex justify-between items-start gap-3 text-sm">
                                        <div>
                                            <p className="font-semibold text-slate-800">{personName.get(e.volunteerId) || "Unknown person"}</p>
                                            <p className="text-xs text-slate-500">
                                                {ukDate(earnedDay(e)) || "Date not known"}
                                                {isHandAward(e) ? ` · Awarded by ${e.awardedByName || "a member of staff"}` : e.awardedBy === "auto" && typeof e.value === "number" ? ` · ${badgeAmount(whoFor.type, e.value)}` : ""}
                                            </p>
                                            {isHandAward(e) && e.reason && <p className="text-xs text-slate-500 italic">{e.reason}</p>}
                                        </div>
                                        {isSuper && isHandAward(e) && (
                                            <button onClick={() => handleWithdraw(e, whoFor)} disabled={withdrawing === e.id} className="text-xs text-red-600 hover:underline shrink-0 disabled:opacity-50">
                                                {withdrawing === e.id ? "Withdrawing…" : "Withdraw"}
                                            </button>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        )}
                        {whoFor.archived !== true && (
                            <button onClick={() => { const id = whoFor.id; setWhoFor(null); openAward(id); }} className="mt-4 text-sm text-purple-700 hover:underline flex items-center gap-1"><HandHeart size={14} /> Award this badge by hand</button>
                        )}
                    </div>
                </div>
            )}

            {/* Recheck summary */}
            {recheck && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
                        <div className="flex justify-between items-center mb-4">
                            <h3 className="font-bold text-xl text-slate-800">Recheck finished</h3>
                            <button onClick={() => setRecheck(null)} aria-label="Close"><X size={24} className="text-slate-400" /></button>
                        </div>
                        <p className="text-sm text-slate-600 mb-3">
                            {recheck.checked} people checked. {recheck.awarded.length === 0 ? "No new badges: everyone already has the badges they have earned." : `${recheck.awarded.reduce((s, a) => s + a.badges.length, 0)} new badges for ${recheck.awarded.length} ${recheck.awarded.length === 1 ? "person" : "people"}.`}
                        </p>
                        {recheck.awarded.length > 0 && (
                            <ul className="divide-y divide-slate-100 text-sm">
                                {recheck.awarded.map((a, i) => (
                                    <li key={i} className="py-2">
                                        <span className="font-semibold text-slate-800">{a.name}</span>{a.archived ? <span className="text-xs text-slate-400"> (archived)</span> : null}
                                        <span className="text-slate-600">: {a.badges.join(", ")}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </div>
            )}

            {/* Award by hand */}
            {awardOpen && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6 max-h-[90vh] overflow-y-auto">
                        <div className="flex justify-between items-center mb-4">
                            <h3 className="font-bold text-xl text-slate-800">Award by hand</h3>
                            <button onClick={() => setAwardOpen(false)} aria-label="Close"><X size={24} className="text-slate-400" /></button>
                        </div>
                        <form onSubmit={handleAward} className="space-y-3">
                            <label className="block text-sm font-semibold text-slate-700">Person
                                <input placeholder="Type to search" className="mt-1 w-full p-2 border rounded font-normal" value={award.search} onChange={e => setAward({ ...award, search: e.target.value })} />
                                <select required size={6} className="mt-2 w-full p-2 border rounded font-normal" value={award.uid} onChange={e => setAward({ ...award, uid: e.target.value })}>
                                    {awardPeople.map(p => <option key={p.uid} value={p.uid}>{p.name}{p.role ? ` (${p.role.replace("_", " ")})` : ""}</option>)}
                                </select>
                            </label>
                            <label className="block text-sm font-semibold text-slate-700">Badge
                                <select required className="mt-1 w-full p-2 border rounded font-normal" value={award.badgeId} onChange={e => setAward({ ...award, badgeId: e.target.value })}>
                                    <option value="">Choose a badge</option>
                                    {awardBadges.map(b => (
                                        <option key={b.id} value={b.id} disabled={!!award.uid && hasBadge(award.uid, b.id)}>
                                            {b.name}{award.uid && hasBadge(award.uid, b.id) ? " (already has it)" : ""}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label className="block text-sm font-semibold text-slate-700">Reason (optional)
                                <textarea rows={2} maxLength={500} className="mt-1 w-full p-2 border rounded font-normal" value={award.reason} onChange={e => setAward({ ...award, reason: e.target.value })} />
                            </label>
                            <p className="text-xs text-slate-500">The badge shows on their profile with today&apos;s date and &quot;Awarded by {user?.displayName || "you"}&quot;. Only a super admin can withdraw it.</p>
                            {awardError && <p role="alert" className="text-sm text-red-600">{awardError}</p>}
                            <button type="submit" disabled={awarding} className="w-full bg-purple-600 text-white py-2 rounded-lg font-bold disabled:opacity-50">{awarding ? "Awarding…" : "Award badge"}</button>
                        </form>
                    </div>
                </div>
            )}
        </DashboardLayout>
    );
}

export default function GuardedBadgesPage() {
    return (
        <RequirePermission perm="badges">
            <BadgesPage />
        </RequirePermission>
    );
}
