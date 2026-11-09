"use client";

// Line managers (29 Sep 2026). Super admin only.
// A line manager is a link between two people (users/{uid}.managerId), not a role.
// The line manager approves the person's leave, gets their leave emails, sees them on My Team
// and can send them policy reminders. Only staff, admins and super admins (not archived) can be
// line managers (30 Sep 2026). Changing it moves pending leave requests (lineManagerChanged).
// "Default for new people" is used by createStaffAccount for every new login.
import DashboardLayout from "@/components/layout/DashboardLayout";
import { useEffect, useMemo, useState } from "react";
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteField } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { stampedBy } from "@/lib/people/changeLog";
import { useAuth } from "@/contexts/AuthContext";
import { Search, ShieldAlert, Network } from "lucide-react";

type U = { uid: string; name: string; email: string; role: string; managerId: string; archived: boolean };
const MANAGER_ROLES = ["super_admin", "admin", "staff"];
const canManage = (u: U) => MANAGER_ROLES.includes(u.role) && !u.archived;
const ROLE_LABEL: Record<string, string> = { volunteer: "Volunteer", staff: "Staff", admin: "Admin", super_admin: "Super admin", standard_user: "No access yet" };

function LineManagers() {
    const { user } = useAuth();
    const [users, setUsers] = useState<U[]>([]);
    const [def, setDef] = useState("");
    const [q, setQ] = useState("");
    const [savedId, setSavedId] = useState("");
    const [err, setErr] = useState("");
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        (async () => {
            try {
                const s = await getDocs(collection(db, "users"));
                setUsers(s.docs.map(d => ({ uid: d.id, name: String(d.data().name || d.data().displayName || d.data().email || d.id), email: String(d.data().email || ""), role: String(d.data().role || ""), managerId: String(d.data().managerId || ""), archived: d.data().archived === true }))
                    .sort((a, b) => a.name.localeCompare(b.name)));
                const c = await getDoc(doc(db, "lineManagement", "settings"));
                setDef(c.exists() ? String(c.data().defaultManagerId || "") : "");
            } catch (e) { console.error(e); setErr("Could not load the users."); }
            finally { setLoading(false); }
        })();
    }, []);

    const byId = useMemo(() => Object.fromEntries(users.map(u => [u.uid, u])), [users]);
    const label = (u: U) => `${u.name} (${ROLE_LABEL[u.role] || u.role || "no role"}, ${u.email})`;
    const filtered = users.filter(u => !q.trim() || `${u.name} ${u.email}`.toLowerCase().includes(q.trim().toLowerCase()));
    const counts = useMemo(() => {
        const c: Record<string, number> = {};
        users.forEach(u => { if (u.managerId) c[u.managerId] = (c[u.managerId] || 0) + 1; });
        return Object.entries(c).sort((a, b) => b[1] - a[1]);
    }, [users]);

    const setManager = async (u: U, managerId: string) => {
        setErr("");
        const m = managerId ? byId[managerId] : null;
        const question = m
            ? `Make ${m.name} the line manager of ${u.name}?${u.managerId ? ` This replaces ${byId[u.managerId]?.name || "their current line manager"}.` : ""} Any leave requests of ${u.name} still waiting will move to ${m.name}.`
            : `Remove the line manager of ${u.name}? Their leave requests will then go to everyone who approves leave.`;
        if (!confirm(question)) { setUsers(prev => [...prev]); return; }
        try {
            await updateDoc(doc(db, "users", u.uid), { managerId: managerId || deleteField(), ...stampedBy(user?.uid || "") });
            setUsers(prev => prev.map(x => x.uid === u.uid ? { ...x, managerId } : x));
            setSavedId(u.uid); setTimeout(() => setSavedId(s => s === u.uid ? "" : s), 3000);
        } catch (e) { console.error(e); setErr(`Not saved for ${u.name}. Only a super admin can change line managers.`); }
    };
    const setDefault = async (id: string) => {
        setErr("");
        if (!confirm(id ? `Give ${byId[id]?.name || "this person"} as the line manager to every new login?` : "Stop giving new logins a line manager?")) { setDef(d => d); return; }
        try {
            await setDoc(doc(db, "lineManagement", "settings"), { defaultManagerId: id, updatedBy: user?.uid || "", updatedAt: new Date().toISOString() });
            setDef(id); setSavedId("__default"); setTimeout(() => setSavedId(""), 3000);
        } catch (e) { console.error(e); setErr("The default was not saved."); }
    };

    if (loading) return <div className="p-8 text-slate-500">Loading…</div>;

    return (
        <div className="max-w-5xl">
            <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2"><Network size={24} /> Line Managers</h1>
            <p className="text-slate-500 mb-2">Choose each person&apos;s line manager. It is a link between two people, not a role. You are asked to confirm each change.</p>
            <p className="text-sm text-slate-600 mb-5 bg-slate-50 border rounded-lg p-3">A line manager approves or rejects the person&apos;s leave, gets an email about each leave request, sees the person on My Team (admins and super admins) and can send them reminders to read policies. Only staff, admins and super admins can be line managers. When you change someone&apos;s line manager, their leave requests that are still waiting move to the new one.</p>
            {err && <div role="alert" className="mb-4 p-3 rounded-lg bg-red-50 border border-red-300 text-red-700 text-sm">{err}</div>}

            <div className="grid md:grid-cols-2 gap-4 mb-5">
                <div className="bg-white rounded-xl border p-4">
                    <p className="font-semibold text-slate-700 text-sm mb-2">Default line manager for new people</p>
                    <select className="w-full p-2 border rounded-lg text-sm" value={def} onChange={e => setDefault(e.target.value)}>
                        <option value="">No default</option>
                        {users.filter(u => canManage(u) || u.uid === def).map(u => <option key={u.uid} value={u.uid}>{label(u)}{canManage(u) ? "" : " (cannot be a line manager)"}</option>)}
                    </select>
                    <p className="text-xs text-slate-500 mt-1">{savedId === "__default" ? <span className="text-green-700 font-semibold">✓ Saved</span> : "Given automatically to every new login (accepted volunteers, new teachers)."}</p>
                </div>
                <div className="bg-white rounded-xl border p-4">
                    <p className="font-semibold text-slate-700 text-sm mb-2">Who manages how many</p>
                    {counts.length === 0 ? <p className="text-sm text-slate-400">Nobody has a line manager yet.</p> : (
                        <ul className="text-sm space-y-1">{counts.map(([id, n]) => <li key={id} className="flex justify-between"><span>{byId[id]?.name || "Unknown person"}</span><span className="font-semibold">{n}</span></li>)}</ul>
                    )}
                    <p className="text-xs text-slate-500 mt-2">{users.filter(u => !u.managerId).length} {users.filter(u => !u.managerId).length === 1 ? "person has" : "people have"} no line manager.</p>
                </div>
            </div>

            <div className="relative mb-3">
                <Search className="absolute left-3 top-2.5 text-slate-400" size={18} />
                <input className="pl-9 pr-3 py-2 border rounded-lg w-full text-sm" placeholder="Search by name or email" value={q} onChange={e => setQ(e.target.value)} />
            </div>

            <div className="bg-white rounded-xl border divide-y">
                {filtered.map(u => (
                    <div key={u.uid} className="p-3 flex flex-col md:flex-row md:items-center gap-2">
                        <div className="md:w-2/5 min-w-0">
                            <p className="font-semibold text-slate-800 truncate">{u.name}</p>
                            <p className="text-xs text-slate-500 truncate">{ROLE_LABEL[u.role] || u.role || "No role"} · {u.email}</p>
                        </div>
                        <div className="flex-1 flex items-center gap-2">
                            <select aria-label={`Line manager of ${u.name}`} className="flex-1 p-2 border rounded-lg text-sm" value={u.managerId} onChange={e => setManager(u, e.target.value)}>
                                <option value="">No line manager</option>
                                {users.filter(m => m.uid !== u.uid && (canManage(m) || m.uid === u.managerId)).map(m => <option key={m.uid} value={m.uid}>{label(m)}{canManage(m) ? "" : " (cannot be a line manager)"}</option>)}
                            </select>
                            <span className="w-16 text-xs text-green-700 font-semibold">{savedId === u.uid ? "✓ Saved" : ""}</span>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

export default function LineManagersPage() {
    const { user } = useAuth();
    return (
        <DashboardLayout>
            {user?.role === "super_admin" ? <LineManagers /> : (
                <div className="p-8"><div className="max-w-md rounded-xl border border-amber-200 bg-amber-50 p-6">
                    <div className="flex items-center gap-2 text-amber-700 font-semibold"><ShieldAlert size={18} /> Super admin only</div>
                    <p className="mt-2 text-sm text-amber-800">Only a super admin can assign line managers.</p>
                </div></div>
            )}
        </DashboardLayout>
    );
}
