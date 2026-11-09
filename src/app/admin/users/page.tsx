"use client";

import DashboardLayout from "@/components/layout/DashboardLayout";
import { useEffect, useMemo, useState } from "react";
import { collection, getDocs, doc, updateDoc, deleteField } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";
import { UserRole } from "@/lib/types";
import {
    PERMISSION_CATALOG,
    PermissionKey,
    ROLE_DEFAULTS,
    REMOVE_WARNING,
} from "@/lib/permissions";
import { Search, ShieldCheck, Save, Check, Lock, AlertTriangle, History, RefreshCw, Users } from "lucide-react";
import {
    ChangeLogEntry,
    fieldLabel,
    formatChangeTime,
    formatChangeValue,
    loadChangesFor,
    loadRecentChanges,
    stampedBy,
} from "@/lib/people/changeLog";
import { rebuildPublicProfiles } from "@/lib/people/publicProfiles";

type Row = {
    uid: string;
    email?: string;
    displayName?: string;
    name?: string;
    role?: UserRole;
    permissions?: string[];
    deniedPermissions?: string[];
    leaveAllowance?: { total: number; remaining: number; year: number; entitlement?: number };
    managerId?: string;
    archived?: boolean;
};

const rowName = (r: Row | null | undefined) => r?.displayName || r?.name || r?.email || r?.uid || "";

/** One list of changes: the newest at the top. */
function ChangeList({ entries, nameOf, showPerson }: { entries: ChangeLogEntry[]; nameOf: (uid: string) => string; showPerson: boolean }) {
    if (!entries.length) return <div className="p-4 text-sm text-slate-400">No changes recorded yet.</div>;
    return (
        <div className="overflow-x-auto">
            <table className="w-full text-sm">
                <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b border-slate-100">
                        <th className="px-3 py-2 font-semibold">When</th>
                        {showPerson && <th className="px-3 py-2 font-semibold">Person</th>}
                        <th className="px-3 py-2 font-semibold">What</th>
                        <th className="px-3 py-2 font-semibold">Before</th>
                        <th className="px-3 py-2 font-semibold">After</th>
                        <th className="px-3 py-2 font-semibold">Changed by</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                    {entries.map(e => (
                        <tr key={e.id} className="align-top">
                            <td className="px-3 py-2 whitespace-nowrap text-slate-500">{formatChangeTime(e.at)}</td>
                            {showPerson && <td className="px-3 py-2 text-slate-800">{e.targetName}</td>}
                            <td className="px-3 py-2 text-slate-700">{fieldLabel(e.field)}</td>
                            <td className="px-3 py-2 text-slate-500">{formatChangeValue(e.field, e.before, nameOf)}</td>
                            <td className="px-3 py-2 text-slate-800">{formatChangeValue(e.field, e.after, nameOf)}</td>
                            <td className="px-3 py-2 text-slate-500">{e.byUid === "unknown" ? "Not recorded" : e.byUid === "system" ? "System" : nameOf(e.byUid)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

// 29 Sep 2026: four roles only. The portal is for super admin, admin and staff;
// volunteers use the app. 'standard_user' stays as the hidden "no access yet" state for
// self sign-ups; 'line_manager' is being replaced by a link between two people.
const ROLES: UserRole[] = ['super_admin', 'admin', 'staff', 'volunteer'];

const GROUPS = Array.from(new Set(PERMISSION_CATALOG.map(p => p.group)));

function UsersPermissionsPage() {
    const { user } = useAuth();
    const [rows, setRows] = useState<Row[]>([]);
    // UK app version each person last opened (appSeen, written by the app since 1 Oct 2026).
    const [appSeen, setAppSeen] = useState<Record<string, { version: string; at: string }>>({});
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const [selected, setSelected] = useState<string | null>(null);
    const [draftRole, setDraftRole] = useState<UserRole>('volunteer');
    const [draftPerms, setDraftPerms] = useState<string[]>([]);
    const [draftDenied, setDraftDenied] = useState<string[]>([]);
    const [leaveDays, setLeaveDays] = useState<string>("");
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Change log (1 Oct 2026): written by the server, newest 200 at the bottom of the page.
    const [log, setLog] = useState<ChangeLogEntry[]>([]);
    const [logLoading, setLogLoading] = useState(true);
    const [logError, setLogError] = useState<string | null>(null);
    const [logPerson, setLogPerson] = useState<string>("");
    const [personLog, setPersonLog] = useState<ChangeLogEntry[]>([]);
    const [personLogLoading, setPersonLogLoading] = useState(false);
    const [rebuilding, setRebuilding] = useState(false);
    const [rebuildNote, setRebuildNote] = useState<string | null>(null);

    useEffect(() => { load(); }, []);
    useEffect(() => { loadLog(logPerson); }, [logPerson]);

    const loadLog = async (uid: string) => {
        setLogLoading(true);
        setLogError(null);
        try {
            setLog(uid ? await loadChangesFor(uid) : await loadRecentChanges(200));
        } catch (e: any) {
            setLogError(e?.message || "Could not load the change log.");
        } finally {
            setLogLoading(false);
        }
    };

    const loadPersonLog = async (uid: string) => {
        setPersonLogLoading(true);
        try {
            setPersonLog(await loadChangesFor(uid, 20));
        } catch {
            setPersonLog([]);
        } finally {
            setPersonLogLoading(false);
        }
    };

    // The trigger writes the log a moment after a save, so look again shortly afterwards.
    const refreshLogsSoon = (uid: string) => {
        setTimeout(() => {
            loadLog(logPerson);
            if (uid) loadPersonLog(uid);
        }, 2500);
    };

    const nameOf = (uid: string) => {
        if (!uid) return "Not set";
        const r = rows.find(x => x.uid === uid);
        return r ? rowName(r) : "Someone no longer listed";
    };

    // Super admins who can still sign in (archived logins are suspended).
    const liveSuperAdmins = rows.filter(r => r.role === 'super_admin' && r.archived !== true);

    const load = async () => {
        setLoading(true);
        try {
            const snap = await getDocs(collection(db, "users"));
            const data: Row[] = snap.docs.map(d => ({ uid: d.id, ...(d.data() as any) }));
            data.sort((a, b) => (a.displayName || a.name || a.email || "").localeCompare(b.displayName || b.name || b.email || ""));
            setRows(data);
            try {
                const seen = await getDocs(collection(db, "appSeen"));
                const m: Record<string, { version: string; at: string }> = {};
                seen.docs.forEach(d => {
                    const x = d.data() as any;
                    const at = x.at && typeof x.at.toDate === 'function' ? x.at.toDate().toLocaleDateString('en-GB') : '';
                    m[d.id] = { version: String(x.version || ''), at };
                });
                setAppSeen(m);
            } catch { /* the list still works without it */ }
        } catch (e: any) {
            setError(e?.message || "Could not load users.");
        } finally {
            setLoading(false);
        }
    };

    const current = rows.find(r => r.uid === selected) || null;

    const select = (r: Row) => {
        setSelected(r.uid);
        setDraftRole((r.role as UserRole) || 'standard_user');
        setDraftPerms(Array.isArray(r.permissions) ? [...r.permissions] : []);
        setDraftDenied(Array.isArray(r.deniedPermissions) ? [...r.deniedPermissions] : []);
        setLeaveDays("");
        setSaved(false);
        setError(null);
        loadPersonLog(r.uid);
    };

    const roleDefaults = ROLE_DEFAULTS[draftRole] || [];

    // Leave follows the role (24 Sep 2026): volunteers have none. Moving someone out of
    // volunteer (or into a leave role without an allowance) asks how many days they get;
    // moving someone into volunteer removes their allowance.
    const currentRole = (current?.role as UserRole) || 'standard_user';
    const roleChanged = !!current && draftRole !== currentRole;
    const needsLeaveDays = roleChanged && draftRole !== 'volunteer' && !current?.leaveAllowance;
    const removesLeave = roleChanged && draftRole === 'volunteer' && !!current?.leaveAllowance;

    // Everything can be switched on or off for one person (29 Sep 2026, Franco).
    // Off for a feature the role gives = deniedPermissions; on for one it does not = permissions.
    // Switching something off shows what it will cause, but never blocks.
    const isOn = (key: PermissionKey) => draftPerms.includes(key) || (roleDefaults.includes(key) && !draftDenied.includes(key));
    const toggle = (key: PermissionKey) => {
        const byRole = roleDefaults.includes(key);
        if (isOn(key)) {
            const label = PERMISSION_CATALOG.find(p => p.key === key)?.label || key;
            const who = current?.displayName || current?.name || current?.email || "this person";
            if (!confirm(`Switch off "${label}" for ${who}?\n\n${REMOVE_WARNING[key]}`)) return;
            setDraftPerms(prev => prev.filter(k => k !== key));
            if (byRole) setDraftDenied(prev => prev.includes(key) ? prev : [...prev, key]);
        } else {
            setDraftDenied(prev => prev.filter(k => k !== key));
            if (!byRole) setDraftPerms(prev => prev.includes(key) ? prev : [...prev, key]);
        }
        setSaved(false);
    };

    const save = async () => {
        if (!current) return;
        const who = rowName(current) || "this person";
        // 1 Oct 2026 (Franco): always confirm a new super admin.
        if (draftRole === 'super_admin' && currentRole !== 'super_admin') {
            if (!confirm(`Make ${who} a super admin?\n\nA super admin has every feature in the portal and the app, can change anyone's role and permissions, and nothing can be switched off for them.`)) return;
        }
        // Removing the last super admin gets a strong warning, but is never blocked.
        if (currentRole === 'super_admin' && draftRole !== 'super_admin') {
            const others = liveSuperAdmins.filter(r => r.uid !== current.uid).length;
            if (others === 0) {
                if (!confirm(`WARNING: ${who} is the LAST super admin.\n\nAfter this change nobody will be able to open Users & Permissions, change roles or permissions, or make a new super admin from the portal. The only way back would be to edit the database directly in the Firebase console.\n\nAre you completely sure you want to go ahead?`)) return;
            } else if (current.uid === user?.uid) {
                if (!confirm(`You are removing your own super admin role. You will lose access to this screen straight away.\n\nGo ahead?`)) return;
            }
        }
        setSaving(true);
        setError(null);
        try {
            // Keys the role already grants are not stored: the grant is implicit and
            // would silently survive a later role change if we wrote it down.
            const extras = draftPerms.filter(k => !roleDefaults.includes(k as PermissionKey));
            const denied = draftRole === 'super_admin' ? [] : draftDenied.filter(k => roleDefaults.includes(k as PermissionKey));
            // Every write from this page says who made it (read by the change log on the server).
            const update: Record<string, any> = { role: draftRole, permissions: extras, deniedPermissions: denied.length ? denied : deleteField(), ...stampedBy(user?.uid) };
            let newLeave: Row['leaveAllowance'] | undefined = current.leaveAllowance;
            if (needsLeaveDays) {
                const n = Number(leaveDays);
                if (leaveDays.trim() === "" || !Number.isInteger(n) || n < 0 || n > 60) {
                    setError("Enter how many days of annual leave they get per year (a whole number from 0 to 60). Nothing was saved.");
                    setSaving(false);
                    return;
                }
                newLeave = { total: n, remaining: n, year: (new Date().getMonth() >= 4 ? new Date().getFullYear() : new Date().getFullYear() - 1), entitlement: n }; // leave year starts 1 May
                update.leaveAllowance = newLeave;
            } else if (removesLeave) {
                update.leaveAllowance = deleteField();
                newLeave = undefined;
            }
            await updateDoc(doc(db, "users", current.uid), update);
            setRows(prev => prev.map(r => r.uid === current.uid ? { ...r, role: draftRole, permissions: extras, deniedPermissions: denied, leaveAllowance: newLeave } : r));
            setDraftDenied(denied);
            setLeaveDays("");
            setDraftPerms(extras);
            setSaved(true);
            refreshLogsSoon(current.uid);
        } catch (e: any) {
            setError(e?.message || "Save failed.");
        } finally {
            setSaving(false);
        }
    };

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return rows;
        return rows.filter(r =>
            (r.displayName || "").toLowerCase().includes(q) ||
            (r.name || "").toLowerCase().includes(q) ||
            (r.email || "").toLowerCase().includes(q) ||
            (r.role || "").toLowerCase().includes(q)
        );
    }, [rows, search]);

    if (user?.role !== 'super_admin') {
        return (
            <DashboardLayout>
                <div className="p-8">
                    <div className="max-w-md rounded-xl border border-amber-200 bg-amber-50 p-6 text-amber-800 text-sm">
                        <div className="flex items-center gap-2 font-semibold text-amber-700 mb-1">
                            <Lock size={16} /> Super admin only
                        </div>
                        Roles and permissions can only be changed by a super admin.
                    </div>
                </div>
            </DashboardLayout>
        );
    }

    return (
        <DashboardLayout>
            <div className="p-4 md:p-8">
                <div className="flex items-center gap-2 mb-1">
                    <ShieldCheck className="text-indigo-600" size={22} />
                    <h1 className="text-2xl font-bold text-slate-800">Users &amp; Permissions</h1>
                </div>
                <p className="text-sm text-slate-500 mb-6">
                    A role sets the starting ticks. You can switch any feature on or off for one person; switching one off shows what it will cause first.
                </p>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    {/* User list */}
                    <div className="lg:col-span-1 bg-white rounded-xl border border-slate-200 overflow-hidden">
                        <div className="p-3 border-b border-slate-100">
                            <div className="relative">
                                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                                <input
                                    value={search}
                                    onChange={e => setSearch(e.target.value)}
                                    placeholder="Search name, email or role"
                                    className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-200"
                                />
                            </div>
                        </div>
                        <div className="max-h-[32rem] overflow-y-auto divide-y divide-slate-100">
                            {loading && <div className="p-4 text-sm text-slate-400">Loading…</div>}
                            {!loading && filtered.length === 0 && <div className="p-4 text-sm text-slate-400">No users match.</div>}
                            {filtered.map(r => {
                                const extras = Array.isArray(r.permissions) ? r.permissions.length : 0;
                                const offs = Array.isArray(r.deniedPermissions) ? r.deniedPermissions.length : 0;
                                return (
                                    <button
                                        key={r.uid}
                                        onClick={() => select(r)}
                                        className={`w-full text-left px-4 py-3 hover:bg-slate-50 transition ${selected === r.uid ? 'bg-indigo-50' : ''}`}
                                    >
                                        <div className="text-sm font-medium text-slate-800 truncate">
                                            {r.displayName || r.name || r.email || r.uid}
                                        </div>
                                        <div className="text-xs text-slate-400 truncate">{r.email}</div>
                                        <div className="mt-1 flex items-center gap-2">
                                            <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 capitalize">
                                                {(r.role || 'no role').replace(/_/g, ' ')}
                                            </span>
                                            {extras > 0 && (
                                                <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">
                                                    +{extras} extra
                                                </span>
                                            )}
                                            {offs > 0 && (
                                                <span className="text-[11px] px-2 py-0.5 rounded-full bg-red-100 text-red-700">
                                                    {offs} off
                                                </span>
                                            )}
                                            {appSeen[r.uid] && (
                                                <span className="text-[11px] px-2 py-0.5 rounded-full bg-sky-50 text-sky-700" title={`Last opened the app on ${appSeen[r.uid].at}`}>
                                                    App {appSeen[r.uid].version}
                                                </span>
                                            )}
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {/* Editor */}
                    <div className="lg:col-span-2 bg-white rounded-xl border border-slate-200 p-5">
                        {!current && (
                            <div className="text-sm text-slate-400 py-16 text-center">
                                Pick someone from the list to edit their access.
                            </div>
                        )}

                        {current && (
                            <>
                                <div className="flex items-start justify-between gap-4 mb-5">
                                    <div>
                                        <div className="text-lg font-semibold text-slate-800">
                                            {current.displayName || current.name || current.email}
                                        </div>
                                        <div className="text-xs text-slate-400">{current.email}</div>
                                    </div>
                                    <button
                                        onClick={save}
                                        disabled={saving}
                                        className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg"
                                    >
                                        {saved ? <Check size={16} /> : <Save size={16} />}
                                        {saving ? "Saving…" : saved ? "Saved" : "Save changes"}
                                    </button>
                                </div>

                                {current.uid === user?.uid && (
                                    <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                                        <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                                        This is your own account. Changing your role away from super admin will lock you out of this screen.
                                    </div>
                                )}

                                <div className="mb-5">
                                    <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Role</label>
                                    <select
                                        value={draftRole}
                                        onChange={e => { setDraftRole(e.target.value as UserRole); setSaved(false); }}
                                        className="w-full md:w-64 border border-slate-200 rounded-lg px-3 py-2 text-sm capitalize"
                                    >
                                        {(ROLES.includes(currentRole) ? ROLES : [...ROLES, currentRole]).map(r => (
                                            <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>
                                        ))}
                                    </select>
                                    <p className="mt-2 text-xs text-slate-400">
                                        The role decides the starting ticks (marked &quot;from role&quot;). Every tick below can be changed for this person.
                                    </p>
                                    {draftRole === 'super_admin' && (
                                        <p className="mt-1 text-xs text-amber-700">A super admin always has every feature, so these ticks cannot be switched off. Change the role first to limit this account.</p>
                                    )}

                                    {needsLeaveDays && (
                                        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 md:w-96">
                                            <label className="block text-sm font-semibold text-amber-900 mb-1">
                                                How many days of annual leave per year?
                                            </label>
                                            <input
                                                type="number"
                                                min={0}
                                                max={60}
                                                step={1}
                                                value={leaveDays}
                                                onChange={e => { setLeaveDays(e.target.value); setSaved(false); }}
                                                className="w-28 border border-amber-300 rounded-lg px-3 py-2 text-sm bg-white"
                                                placeholder="e.g. 16"
                                            />
                                            <p className="mt-2 text-xs text-amber-800">
                                                Required when moving someone out of volunteer. Do not include bank holidays: they are always off and are never taken from this allowance.
                                            </p>
                                        </div>
                                    )}
                                    {removesLeave && (
                                        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 md:w-96">
                                            Volunteers have no annual leave. Their allowance of {current?.leaveAllowance?.entitlement ?? current?.leaveAllowance?.total} days will be removed when you save.
                                        </div>
                                    )}
                                    {!needsLeaveDays && !removesLeave && current?.leaveAllowance && (
                                        <p className="mt-2 text-xs text-slate-500">
                                            Annual leave: {current.leaveAllowance.remaining} of {current.leaveAllowance.total} days left this year{typeof current.leaveAllowance.entitlement === 'number' ? ` (entitlement ${current.leaveAllowance.entitlement})` : ''}.
                                        </p>
                                    )}
                                </div>

                                <div className="space-y-5">
                                    {GROUPS.map(group => (
                                        <div key={group}>
                                            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">{group}</div>
                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                                {PERMISSION_CATALOG.filter(p => p.group === group).map(p => {
                                                    const byRole = roleDefaults.includes(p.key);
                                                    const isSuper = draftRole === 'super_admin';
                                                    const ticked = isSuper || isOn(p.key);
                                                    const switchedOff = byRole && !ticked;
                                                    return (
                                                        <label
                                                            key={p.key}
                                                            title={isSuper ? "A super admin always has everything." : ""}
                                                            className={`flex items-start gap-3 rounded-lg border px-3 py-2 transition ${isSuper ? 'border-slate-100 bg-slate-50' : 'cursor-pointer'} ${!isSuper && ticked
                                                                ? 'border-emerald-200 bg-emerald-50'
                                                                : !isSuper && switchedOff ? 'border-red-200 bg-red-50' : !isSuper ? 'border-slate-200 hover:bg-slate-50' : ''
                                                                }`}
                                                        >
                                                            <input
                                                                type="checkbox"
                                                                className="mt-1"
                                                                checked={ticked}
                                                                disabled={isSuper}
                                                                onChange={() => toggle(p.key)}
                                                            />
                                                            <span className="min-w-0">
                                                                <span className="block text-sm font-medium text-slate-800">
                                                                    {p.label}
                                                                    {byRole && ticked && !isSuper && <span className="ml-2 text-[11px] text-slate-400 font-normal">from role</span>}
                                                                    {switchedOff && <span className="ml-2 text-[11px] text-red-600 font-semibold">switched off</span>}
                                                                </span>
                                                                <span className="block text-xs text-slate-500">{p.description}</span>
                                                            </span>
                                                        </label>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    ))}
                                </div>

                                {error && (
                                    <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                                        {error}
                                    </div>
                                )}

                                <div className="mt-6 border-t border-slate-100 pt-4">
                                    <div className="flex items-center gap-2 mb-2">
                                        <History size={16} className="text-slate-500" />
                                        <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Recent changes for {rowName(current)}</span>
                                    </div>
                                    {personLogLoading
                                        ? <div className="p-4 text-sm text-slate-400">Loading…</div>
                                        : <ChangeList entries={personLog} nameOf={nameOf} showPerson={false} />}
                                </div>
                            </>
                        )}
                    </div>
                </div>

                {/* Change log (1 Oct 2026): written by the server, cannot be edited. */}
                <div className="mt-6 bg-white rounded-xl border border-slate-200 overflow-hidden">
                    <div className="p-4 border-b border-slate-100 flex flex-wrap items-center gap-3 justify-between">
                        <div>
                            <div className="flex items-center gap-2">
                                <History size={18} className="text-indigo-600" />
                                <h2 className="text-lg font-semibold text-slate-800">Change log</h2>
                            </div>
                            <p className="text-xs text-slate-500 mt-1">
                                Every change to a role, features, line manager, archive or yearly leave entitlement, from any page. The newest 200 are shown. Nobody can edit or delete this list.
                            </p>
                        </div>
                        <div className="flex items-center gap-2">
                            <select
                                value={logPerson}
                                onChange={e => setLogPerson(e.target.value)}
                                className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
                                aria-label="Show changes for"
                            >
                                <option value="">Everyone</option>
                                {rows.map(r => <option key={r.uid} value={r.uid}>{rowName(r)}</option>)}
                            </select>
                            <button
                                onClick={() => loadLog(logPerson)}
                                className="inline-flex items-center gap-1 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
                            >
                                <RefreshCw size={14} /> Refresh
                            </button>
                        </div>
                    </div>
                    {logLoading && <div className="p-4 text-sm text-slate-400">Loading…</div>}
                    {!logLoading && logError && <div className="p-4 text-sm text-red-700">{logError}</div>}
                    {!logLoading && !logError && <ChangeList entries={log} nameOf={nameOf} showPerson={!logPerson} />}
                </div>

                {/* Public directory (1 Oct 2026): what volunteers in the app see of other people. */}
                <div className="mt-6 bg-white rounded-xl border border-slate-200 p-4 flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                        <div className="flex items-center gap-2">
                            <Users size={18} className="text-indigo-600" />
                            <h2 className="text-lg font-semibold text-slate-800">Public directory</h2>
                        </div>
                        <p className="text-xs text-slate-500 mt-1 max-w-2xl">
                            Volunteers in the app only see the name, photo and role of other people. The server keeps this list up to date by itself. Rebuild it once after it is first switched on, or if a name looks wrong in the app.
                        </p>
                        {rebuildNote && <p className="text-xs text-slate-700 mt-2">{rebuildNote}</p>}
                    </div>
                    <button
                        onClick={async () => {
                            setRebuilding(true);
                            setRebuildNote(null);
                            try {
                                const r = await rebuildPublicProfiles();
                                setRebuildNote(`Done. ${r.written} ${r.written === 1 ? "person" : "people"} written${r.removed ? `, ${r.removed} old ${r.removed === 1 ? "entry" : "entries"} removed` : ""}.`);
                            } catch (e: any) {
                                setRebuildNote(e?.message || "The rebuild failed.");
                            } finally {
                                setRebuilding(false);
                            }
                        }}
                        disabled={rebuilding}
                        className="inline-flex items-center gap-2 border border-indigo-200 text-indigo-700 hover:bg-indigo-50 disabled:opacity-50 text-sm font-medium px-4 py-2 rounded-lg"
                    >
                        <RefreshCw size={16} className={rebuilding ? "animate-spin" : ""} />
                        {rebuilding ? "Rebuilding…" : "Rebuild public directory"}
                    </button>
                </div>
            </div>
        </DashboardLayout>
    );
}

export default UsersPermissionsPage;
