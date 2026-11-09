"use client";

import { useState, useEffect, useCallback } from "react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import { useAuth } from "@/contexts/AuthContext";
import {
    collection, query, where, getDocs, addDoc, updateDoc, doc, serverTimestamp, orderBy, limit
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { LeaveRequest, LeaveType, UserProfile } from "@/lib/types";
import {
    Check, X, AlertTriangle, User, RefreshCw, Search, PlusCircle, CheckCircle, FileText, RotateCcw
} from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import {
    MAX_CARRY_OVER, calculateLeaveDays, actionLeaveRequest, runAnnualLeaveReset, fetchLeaveResetPreview,
    saveLeaveAllowance, leaveYearLabel, formatDateTime, hasLeaveRole, LeaveAllowance, LeaveResetPreview
} from "@/lib/leaveUtils";
import { can } from "@/lib/permissions";

const formatDateSafe = (dateVal: any, formatStr: string) => {
    if (!dateVal) return "N/A";
    try {
        const d = dateVal.toDate ? dateVal.toDate() : new Date(dateVal);
        if (isNaN(d.getTime())) return "Invalid date";
        return format(d, formatStr);
    } catch {
        return "Invalid date";
    }
};

const TYPE_LABEL: Record<string, string> = { annual: "Annual leave", sick: "Sick leave", toil: "TOIL", unpaid: "Unpaid leave" };
const errText = (e: any) => String(e?.message || e || "Unknown error");

const LoadError = ({ text, onRetry }: { text: string; onRetry: () => void }) => (
    <div role="alert" className="p-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm flex flex-col sm:flex-row sm:items-center gap-3">
        <span className="flex items-center gap-2 flex-1"><AlertTriangle size={16} /> {text}</span>
        <button onClick={onRetry} className="px-3 py-1.5 rounded-lg bg-white border border-red-300 font-semibold hover:bg-red-100 flex items-center gap-1 self-start"><RotateCcw size={14} /> Try again</button>
    </div>
);

// --- Sub-Components ---

const LeaveBalanceCard = ({ user }: { user: UserProfile }) => {
    const la = user.leaveAllowance as LeaveAllowance | undefined;
    const eligible = hasLeaveRole(user.role);

    return (
        <div className="p-6 rounded-xl shadow-sm border mb-6" style={{ backgroundColor: "white", borderColor: "#e2e8f0" }}>
            <h3 className="font-semibold text-slate-700">My Allowance</h3>
            <p className="text-xs text-slate-500 mb-4">{leaveYearLabel()}</p>
            {!la ? (
                <div className="text-center py-2">
                    <div className="text-2xl font-bold text-slate-400">{eligible ? "Not set" : "Not eligible"}</div>
                    <p className="text-xs text-slate-500 mt-2">
                        {user.role === "volunteer" ? "Volunteers do not have annual leave." : eligible ? "Your leave allowance has not been set yet. Please ask your line manager." : "Your role does not have annual leave."}
                    </p>
                </div>
            ) : (
                <>
                    <div className="grid grid-cols-3 gap-4 text-center divide-x divide-slate-100">
                        <div>
                            <div className="text-2xl font-bold text-slate-900">{la.total}</div>
                            <div className="text-xs text-slate-500 uppercase tracking-wide mt-1">Total days</div>
                        </div>
                        <div>
                            <div className="text-2xl font-bold" style={{ color: "#2c4a00" }}>{la.remaining}</div>
                            <div className="text-xs text-slate-500 uppercase tracking-wide mt-1">Left</div>
                        </div>
                        <div>
                            <div className="text-2xl font-bold text-slate-400">{Math.max(0, (Number(la.total) || 0) - (Number(la.remaining) || 0))}</div>
                            <div className="text-xs text-slate-500 uppercase tracking-wide mt-1">Taken</div>
                        </div>
                    </div>
                    {(typeof la.entitlement === "number" || typeof la.carriedOver === "number") && (
                        <p className="mt-3 text-xs text-slate-500 text-center">
                            {typeof la.entitlement === "number" ? `Yearly entitlement ${la.entitlement} days` : ""}
                            {typeof la.entitlement === "number" && typeof la.carriedOver === "number" ? ", " : ""}
                            {typeof la.carriedOver === "number" ? `${la.carriedOver} carried over` : ""}
                        </p>
                    )}
                </>
            )}
            <div className="mt-4 text-xs text-slate-500 bg-slate-50 p-2 rounded">
                Up to {MAX_CARRY_OVER} unused days carry over to the next leave year. Approved TOIL adds days to your balance.
            </div>
        </div>
    );
};

const RequestLeaveForm = ({ user, onClose, onSuccess }: { user: UserProfile, onClose: () => void, onSuccess: () => void }) => {
    const [loading, setLoading] = useState(false);
    const [formData, setFormData] = useState({ startDate: "", endDate: "", type: "annual" as LeaveType, reason: "" });
    const [error, setError] = useState("");

    const endBeforeStart = !!formData.startDate && !!formData.endDate && formData.endDate < formData.startDate;
    const totalDays = calculateLeaveDays(formData.startDate, formData.endDate, formData.type);
    const la = user.leaveAllowance;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        try {
            if (!formData.startDate || !formData.endDate) throw new Error("Please choose both dates.");
            if (endBeforeStart) throw new Error("The end date is before the start date.");
            if (totalDays <= 0) throw new Error(formData.type === "toil" ? "Please choose the days you worked." : "These dates are all weekends or bank holidays, so there are no leave days to take.");
            if (formData.type === "annual") {
                if (!la) throw new Error("Your leave allowance has not been set yet, so annual leave cannot be requested. Please ask your line manager.");
                if (la.remaining < totalDays) throw new Error(`Not enough leave left. You have ${la.remaining} days left.`);
            }
            setLoading(true);
            const request: Omit<LeaveRequest, "id"> = {
                userId: user.uid,
                userName: user.displayName || user.email || "Unknown",
                managerId: user.managerId || "",
                type: formData.type,
                startDate: formData.startDate,
                endDate: formData.endDate,
                totalDays,
                reason: formData.reason,
                status: "pending",
                createdAt: new Date().toISOString(),
            };
            await addDoc(collection(db, "leave_records"), { ...request, createdAt: serverTimestamp() });
            onSuccess();
            onClose();
        } catch (err: any) {
            setError(err?.code === "permission-denied" ? "The request was not saved. Please check the dates and try again." : errText(err));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="p-6 rounded-xl border" style={{ backgroundColor: "white", borderColor: "#e2e8f0" }}>
            <div className="flex justify-between items-center mb-4">
                <h3 className="font-bold text-lg text-slate-800">New Leave Request</h3>
                <button onClick={onClose} aria-label="Close"><X size={20} className="text-slate-400 hover:text-slate-600" /></button>
            </div>

            {error && (
                <div role="alert" className="mb-4 p-3 bg-red-50 text-red-700 rounded-lg text-sm flex items-center gap-2">
                    <AlertTriangle size={16} /> {error}
                </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                    <label className="block text-xs font-bold text-slate-500 mb-1">Type</label>
                    <select value={formData.type} onChange={(e) => setFormData({ ...formData, type: e.target.value as LeaveType })} className="w-full p-2 border rounded text-sm bg-white">
                        <option value="annual">Annual leave</option>
                        <option value="sick">Sick leave</option>
                        <option value="toil">TOIL (days worked on a weekend or bank holiday)</option>
                        <option value="unpaid">Unpaid leave</option>
                    </select>
                    {formData.type === "toil" && (
                        <p className="text-xs text-slate-500 mt-1">Claim the days you WORKED on a weekend or bank holiday. Every day from the first to the last counts. Once approved, the days are added to your leave balance.</p>
                    )}
                </div>

                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className="block text-xs font-bold text-slate-500 mb-1">{formData.type === "toil" ? "First day worked" : "From"}</label>
                        <input type="date" required value={formData.startDate} onChange={(e) => setFormData({ ...formData, startDate: e.target.value })} className="w-full p-2 border rounded text-sm" />
                    </div>
                    <div>
                        <label className="block text-xs font-bold text-slate-500 mb-1">{formData.type === "toil" ? "Last day worked" : "To"}</label>
                        <input type="date" required min={formData.startDate || undefined} value={formData.endDate} onChange={(e) => setFormData({ ...formData, endDate: e.target.value })} className={cn("w-full p-2 border rounded text-sm", endBeforeStart && "border-red-400")} />
                    </div>
                </div>
                {endBeforeStart && <p className="text-xs text-red-600 -mt-2">The end date is before the start date.</p>}

                <div className="text-xs p-2 rounded flex justify-between" style={{ color: "#2c4a00", backgroundColor: "#f0fdf4" }}>
                    <span>{formData.type === "toil" ? "Days claimed" : "Days requested"}: <strong>{totalDays}</strong></span>
                    <span>Left now: <strong>{la ? la.remaining : "Not set"}</strong></span>
                </div>

                <div>
                    <label className="block text-xs font-bold text-slate-500 mb-1">Reason</label>
                    <textarea value={formData.reason} onChange={(e) => setFormData({ ...formData, reason: e.target.value })} rows={2} className="w-full p-2 border rounded text-sm" placeholder={formData.type === "toil" ? "What did you work on?" : "Optional"} />
                </div>

                <button type="submit" disabled={loading || endBeforeStart} className="w-full text-white py-2 rounded font-bold hover:opacity-90 transition-opacity disabled:opacity-50 text-sm" style={{ backgroundColor: "#7f4c12" }}>
                    {loading ? "Submitting..." : "Submit Request"}
                </button>
            </form>
        </div>
    );
};

const MyRequestsList = ({ user, refreshTrigger }: { user: UserProfile, refreshTrigger: number }) => {
    const [requests, setRequests] = useState<(LeaveRequest & { cancelledAt?: string })[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");

    const load = useCallback(async () => {
        setLoading(true); setError("");
        try {
            const q = query(collection(db, "leave_records"), where("userId", "==", user.uid), orderBy("createdAt", "desc"));
            const snap = await getDocs(q);
            setRequests(snap.docs.map(d => ({ id: d.id, ...d.data() } as LeaveRequest)));
        } catch (e) {
            console.error(e);
            setError("Your leave history could not be loaded. " + errText(e));
        } finally {
            setLoading(false);
        }
    }, [user.uid]);

    useEffect(() => { load(); }, [load, refreshTrigger]);

    // 30 Sep 2026: people can cancel their own request while it is still pending.
    // The rules allow the requester only this one change (pending to cancelled).
    const cancelRequest = async (req: LeaveRequest) => {
        if (!confirm("Cancel this leave request?")) return;
        try {
            await updateDoc(doc(db, "leave_records", req.id), { status: "cancelled", cancelledAt: new Date().toISOString() });
            setRequests(prev => prev.map(r => r.id === req.id ? { ...r, status: "cancelled" } : r));
        } catch (e) {
            console.error(e);
            alert("The request could not be cancelled. It may already have been decided.");
        }
    };

    if (loading) return <div className="text-center py-4 text-slate-400 text-sm">Loading history...</div>;
    if (error) return <LoadError text={error} onRetry={load} />;
    if (requests.length === 0) return <div className="text-center py-8 text-slate-400 text-sm border rounded-xl border-dashed">No leave history.</div>;

    return (
        <div className="space-y-3">
            <h3 className="font-semibold text-slate-700">Request History</h3>
            {requests.map(req => (
                <div key={req.id} className="p-4 rounded-lg border shadow-sm" style={{ backgroundColor: "white", borderColor: "#e2e8f0" }}>
                    <div className="flex justify-between items-center gap-3">
                        <div>
                            <div className="flex items-center gap-2 mb-1">
                                <span className={cn("text-xs font-bold uppercase px-2 py-0.5 rounded",
                                    req.status === "approved" ? "bg-green-100 text-green-700" :
                                        req.status === "rejected" ? "bg-red-100 text-red-700" :
                                            req.status === "cancelled" ? "bg-slate-100 text-slate-500" : "bg-orange-100 text-orange-700")}>
                                    {req.status}
                                </span>
                                <span className="text-xs text-slate-500">{TYPE_LABEL[req.type] || req.type}</span>
                            </div>
                            <div className="text-sm font-medium text-slate-800">
                                {req.totalDays} {req.totalDays === 1 ? "day" : "days"} ({formatDateSafe(req.startDate, "d MMM")} to {formatDateSafe(req.endDate, "d MMM yyyy")})
                            </div>
                        </div>
                        <div className="text-xs text-slate-400 text-right space-y-1">
                            <div>{formatDateSafe(req.createdAt, "d MMM yyyy")}</div>
                            {req.status === "pending" && (
                                <button onClick={() => cancelRequest(req)} className="text-red-600 hover:underline font-medium">Cancel request</button>
                            )}
                        </div>
                    </div>
                    {req.status === "rejected" && req.rejectionReason && (
                        <p className="mt-2 text-sm text-red-700 bg-red-50 border border-red-100 rounded p-2"><span className="font-semibold">Reason:</span> {req.rejectionReason}</p>
                    )}
                </div>
            ))}
        </div>
    );
};

const TeamRequests = ({ user }: { user: UserProfile }) => {
    const [requests, setRequests] = useState<LeaveRequest[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [rejecting, setRejecting] = useState<string>("");
    const [reason, setReason] = useState("");
    const [busy, setBusy] = useState("");

    const manageAll = can(user, "leave_manage");
    const fetchRequests = useCallback(async () => {
        setLoading(true); setError("");
        try {
            const q = manageAll
                ? query(collection(db, "leave_records"), where("status", "==", "pending"), orderBy("createdAt", "desc"), limit(50))
                : query(collection(db, "leave_records"), where("managerId", "==", user.uid), where("status", "==", "pending"), orderBy("createdAt", "desc"));
            const snap = await getDocs(q);
            setRequests(snap.docs.map(d => ({ id: d.id, ...d.data() } as LeaveRequest)));
        } catch (e) {
            console.error(e);
            setError("The requests could not be loaded. " + errText(e));
        } finally {
            setLoading(false);
        }
    }, [user.uid, manageAll]);

    useEffect(() => { fetchRequests(); }, [fetchRequests]);

    const decide = async (req: LeaveRequest, status: "approved" | "rejected") => {
        if (status === "rejected" && !reason.trim()) { alert("Please give a reason for rejecting this request."); return; }
        if (!confirm(status === "approved" ? "Approve this request?" : "Reject this request?")) return;
        setBusy(req.id);
        try {
            await actionLeaveRequest(req.id, status, user.uid, status === "rejected" ? reason : undefined);
            setRejecting(""); setReason("");
            await fetchRequests();
        } catch (e: any) {
            alert(errText(e));
        } finally {
            setBusy("");
        }
    };

    if (loading) return <div className="p-8 text-center text-slate-400">Loading requests...</div>;
    if (error) return <LoadError text={error} onRetry={fetchRequests} />;
    if (requests.length === 0) return <div className="p-12 text-center bg-white rounded-xl border border-slate-100 text-slate-400">No pending requests.</div>;

    return (
        <div className="space-y-4">
            {requests.map((request) => (
                <div key={request.id} className="p-6 rounded-xl shadow-sm border" style={{ backgroundColor: "white", borderColor: "#e2e8f0" }}>
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div className="flex-1">
                            <div className="flex items-center gap-2 mb-2">
                                <div className="w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs text-white" style={{ backgroundColor: "#2c4a00" }}>
                                    {(request.userName || "U").charAt(0)}
                                </div>
                                <div>
                                    <h3 className="font-bold text-slate-900 text-sm">{request.userName}</h3>
                                    <p className="text-xs text-slate-500">{TYPE_LABEL[request.type] || request.type}</p>
                                </div>
                            </div>
                            <div className="bg-slate-50 p-3 rounded-lg border border-slate-100 text-sm text-slate-700 grid grid-cols-2 gap-2">
                                <div>From: <span className="font-semibold">{formatDateSafe(request.startDate, "d MMM yyyy")}</span></div>
                                <div>To: <span className="font-semibold">{formatDateSafe(request.endDate, "d MMM yyyy")}</span></div>
                                <div className="col-span-2">Duration: <span className="font-semibold">{request.totalDays} {request.totalDays === 1 ? "day" : "days"}</span>
                                    {request.type === "toil" && <span className="text-xs text-slate-500"> (days worked; approving adds them to the balance)</span>}
                                </div>
                                {request.reason && <div className="col-span-2 text-slate-500 italic">&ldquo;{request.reason}&rdquo;</div>}
                            </div>
                        </div>
                        {rejecting !== request.id && (
                            <div className="flex gap-2">
                                <button disabled={!!busy} onClick={() => decide(request, "approved")} className="flex-1 bg-green-50 text-green-700 hover:bg-green-100 px-4 py-2 rounded-lg font-medium text-sm flex items-center justify-center gap-1 border border-green-200 disabled:opacity-50">
                                    <Check size={16} /> {busy === request.id ? "Saving..." : "Approve"}
                                </button>
                                <button disabled={!!busy} onClick={() => { setRejecting(request.id); setReason(""); }} className="flex-1 bg-red-50 text-red-700 hover:bg-red-100 px-4 py-2 rounded-lg font-medium text-sm flex items-center justify-center gap-1 border border-red-200 disabled:opacity-50">
                                    <X size={16} /> Reject
                                </button>
                            </div>
                        )}
                    </div>
                    {rejecting === request.id && (
                        <div className="mt-4 p-3 rounded-lg border border-red-200 bg-red-50">
                            <label className="block text-xs font-bold text-red-800 mb-1" htmlFor={`reason-${request.id}`}>Reason for rejecting (required, the person will see it)</label>
                            <textarea id={`reason-${request.id}`} autoFocus rows={2} value={reason} onChange={e => setReason(e.target.value)} className="w-full p-2 border rounded text-sm bg-white" />
                            <div className="flex gap-2 mt-2 justify-end">
                                <button onClick={() => { setRejecting(""); setReason(""); }} className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-sm">Back</button>
                                <button disabled={!reason.trim() || !!busy} onClick={() => decide(request, "rejected")} className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-sm font-semibold disabled:opacity-50">
                                    {busy === request.id ? "Saving..." : "Reject request"}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
};

const AllowancesTable = () => {
    const [users, setUsers] = useState<UserProfile[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [searchTerm, setSearchTerm] = useState("");
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editForm, setEditForm] = useState({ entitlement: "", remaining: "" });
    const [saving, setSaving] = useState(false);

    const fetchUsers = useCallback(async () => {
        setLoading(true); setError("");
        try {
            // Only people who have leave: staff, admins, super admins (not archived).
            const q = query(collection(db, "users"), where("role", "in", ["admin", "super_admin", "staff"]));
            const snap = await getDocs(q);
            setUsers(snap.docs.map(d => {
                const data = d.data();
                return { ...data, uid: d.id, displayName: data.name || data.displayName || data.email || d.id } as UserProfile;
            }).filter(u => u.archived !== true).sort((a, b) => (a.displayName || "").localeCompare(b.displayName || "")));
        } catch (e) {
            console.error(e);
            setError("The allowances could not be loaded. " + errText(e));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchUsers(); }, [fetchUsers]);

    const startEdit = (u: UserProfile) => {
        const la = u.leaveAllowance as LeaveAllowance | undefined;
        setEditingId(u.uid);
        setEditForm({
            entitlement: la ? String(typeof la.entitlement === "number" ? la.entitlement : la.total ?? "") : "",
            remaining: la ? String(la.remaining ?? "") : "",
        });
    };

    const saveEdit = async (u: UserProfile) => {
        const entitlement = Number(editForm.entitlement);
        const remaining = Number(editForm.remaining);
        if (editForm.entitlement.trim() === "" || editForm.remaining.trim() === "") { alert("Please fill in both boxes."); return; }
        setSaving(true);
        try {
            const next = await saveLeaveAllowance(u.uid, u.leaveAllowance as LeaveAllowance | undefined, entitlement, remaining);
            setUsers(prev => prev.map(x => x.uid === u.uid ? { ...x, leaveAllowance: next } : x));
            setEditingId(null);
        } catch (e: any) {
            console.error(e);
            alert(e?.code === "permission-denied" ? "Not saved. You can change other people's allowances, not your own (the super admin can)." : "Not saved. " + errText(e));
        } finally {
            setSaving(false);
        }
    };

    const filtered = users.filter(u => u.displayName?.toLowerCase().includes(searchTerm.toLowerCase()) || u.email?.toLowerCase().includes(searchTerm.toLowerCase()));

    if (loading) return <div className="p-8 text-center text-slate-400">Loading people...</div>;
    if (error) return <LoadError text={error} onRetry={fetchUsers} />;

    return (
        <div className="space-y-4">
            <p className="text-sm text-slate-500">{leaveYearLabel()}. The yearly entitlement lasts from year to year; days left now is this leave year&apos;s balance.</p>
            <div className="rounded-xl shadow-sm border overflow-hidden" style={{ backgroundColor: "white", borderColor: "#e2e8f0" }}>
                <div className="p-4 border-b bg-slate-50 flex items-center gap-2" style={{ borderColor: "#e2e8f0" }}>
                    <Search className="text-slate-400" size={16} />
                    <input type="text" placeholder="Search staff..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} className="bg-transparent outline-none w-full text-sm" />
                </div>
                <div className="max-h-[560px] overflow-auto">
                    <table className="w-full text-sm text-left">
                        <thead className="bg-slate-50 text-xs uppercase text-slate-500 sticky top-0">
                            <tr>
                                <th className="px-4 py-3">Staff</th>
                                <th className="px-4 py-3 text-center">Yearly entitlement</th>
                                <th className="px-4 py-3 text-center">Carried over</th>
                                <th className="px-4 py-3 text-center">Total</th>
                                <th className="px-4 py-3 text-center">Days left now</th>
                                <th className="px-4 py-3 text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {filtered.map(u => {
                                const la = u.leaveAllowance as LeaveAllowance | undefined;
                                const editing = editingId === u.uid;
                                return (
                                    <tr key={u.uid} className="hover:bg-slate-50">
                                        <td className="px-4 py-3">
                                            <div className="font-medium text-slate-900">{u.displayName || u.email}</div>
                                            <div className="text-xs text-slate-400">{u.role}</div>
                                        </td>
                                        <td className="px-4 py-3 text-center">
                                            {editing ? (
                                                <input type="number" min={0} aria-label="Yearly entitlement" value={editForm.entitlement}
                                                    onChange={e => setEditForm({ ...editForm, entitlement: e.target.value })} className="w-20 p-1 border rounded text-center" />
                                            ) : <span className="font-mono">{la ? (typeof la.entitlement === "number" ? la.entitlement : `${la.total}*`) : "Not set"}</span>}
                                        </td>
                                        <td className="px-4 py-3 text-center font-mono">{typeof la?.carriedOver === "number" ? la.carriedOver : "0"}</td>
                                        <td className="px-4 py-3 text-center font-mono">{la ? la.total : "Not set"}</td>
                                        <td className="px-4 py-3 text-center">
                                            {editing ? (
                                                <input type="number" aria-label="Days left now" value={editForm.remaining}
                                                    onChange={e => setEditForm({ ...editForm, remaining: e.target.value })} className="w-20 p-1 border rounded text-center font-bold" style={{ color: "#2c4a00" }} />
                                            ) : <span className="font-mono font-bold" style={{ color: "#2c4a00" }}>{la ? la.remaining : "Not set"}</span>}
                                        </td>
                                        <td className="px-4 py-3 text-right">
                                            {editing ? (
                                                <div className="flex justify-end gap-2">
                                                    <button disabled={saving} onClick={() => saveEdit(u)} className="text-green-700 hover:bg-green-50 p-1 rounded disabled:opacity-50" aria-label="Save"><Check size={16} /></button>
                                                    <button disabled={saving} onClick={() => setEditingId(null)} className="text-red-600 hover:bg-red-50 p-1 rounded" aria-label="Cancel"><X size={16} /></button>
                                                </div>
                                            ) : (
                                                <button onClick={() => startEdit(u)} className="text-slate-500 hover:text-blue-600 px-2 py-1 text-xs border rounded hover:border-blue-300 transition-colors">Edit</button>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                            {filtered.length === 0 && (
                                <tr><td colSpan={6} className="p-8 text-center text-slate-400">No staff found.</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
            <p className="text-xs text-slate-500">* No yearly entitlement saved yet: the yearly reset uses the total instead. Saving sets the total to the entitlement plus any days carried over.</p>
        </div>
    );
};

const YearlyResetTab = () => {
    const [preview, setPreview] = useState<LeaveResetPreview | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [running, setRunning] = useState(false);
    const [note, setNote] = useState("");

    const load = useCallback(async () => {
        setLoading(true); setError("");
        try { setPreview(await fetchLeaveResetPreview()); }
        catch (e) { console.error(e); setError("The preview could not be loaded. " + errText(e)); }
        finally { setLoading(false); }
    }, []);
    useEffect(() => { load(); }, [load]);

    const repeatWarning = (y: number) =>
        `WARNING: the yearly reset has ALREADY run for the leave year starting 1 May ${y}.\n\n` +
        `Running it again gives everyone their entitlement again plus up to ${MAX_CARRY_OVER} of the days they have left now. ` +
        `Leave already taken this year would be given back, and it cannot be undone.\n\nRun it again anyway?`;

    const run = async () => {
        if (!preview) return;
        setNote("");
        const repeat = preview.alreadyRunThisYear;
        const ok = repeat
            ? confirm(repeatWarning(preview.leaveYear))
            : confirm(`Reset annual leave for ${preview.people.length} ${preview.people.length === 1 ? "person" : "people"} now, as shown in the table?\n\nIt cannot be undone.`);
        if (!ok) return;
        setRunning(true);
        try {
            let res = await runAnnualLeaveReset({ confirmRepeat: repeat });
            if (!res.ran && res.alreadyRun) {
                // Someone (or the automatic run) did it in the meantime.
                if (!confirm(repeatWarning(res.leaveYear || preview.leaveYear))) { setRunning(false); await load(); return; }
                res = await runAnnualLeaveReset({ confirmRepeat: true });
            }
            setNote(res.ran ? `Reset done for ${res.count ?? 0} ${res.count === 1 ? "person" : "people"}.` : `Nothing was changed. ${res.reason || ""}`);
            await load();
        } catch (e) {
            console.error(e);
            setNote("The reset did not run and nothing was changed. " + errText(e));
        } finally {
            setRunning(false);
        }
    };

    if (loading) return <div className="p-8 text-center text-slate-400">Loading preview...</div>;
    if (error || !preview) return <LoadError text={error || "The preview could not be loaded."} onRetry={load} />;

    const last = preview.lastRun;
    const lastText = last
        ? `Last reset: ${formatDateTime(last.at) || "date not recorded"}, by ${last.by === "automatic" ? "automatic" : (last.byName || "a super admin")}, ${last.manual ? "manual" : "automatic"} (leave year starting 1 May ${last.leaveYear}, ${last.people} ${last.people === 1 ? "person" : "people"})`
        : "Last reset: none recorded yet";

    return (
        <div className="space-y-4">
            <div className="p-6 rounded-xl shadow-sm border flex flex-col md:flex-row md:items-center justify-between gap-4" style={{ backgroundColor: "white", borderColor: "#e2e8f0" }}>
                <div>
                    <h3 className="font-bold text-slate-800 flex items-center gap-2"><RefreshCw className="text-blue-600" size={18} /> Yearly Reset</h3>
                    <p className="text-sm text-slate-600 mt-1">{lastText}</p>
                    <p className="text-xs text-slate-500 max-w-xl mt-1">
                        Runs automatically in May for the new leave year. Staff, admins and super admins get their yearly entitlement plus up to {MAX_CARRY_OVER} days carried over. Volunteers and archived people are left out.
                    </p>
                </div>
                <button onClick={run} disabled={running} className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg font-bold text-sm disabled:opacity-50 whitespace-nowrap">
                    {running ? "Running..." : "Run Yearly Reset"}
                </button>
            </div>

            {preview.alreadyRunThisYear && (
                <div role="alert" className="p-4 rounded-lg border-2 border-red-400 bg-red-50 text-red-800 text-sm font-medium flex items-start gap-2">
                    <AlertTriangle size={18} className="shrink-0 mt-0.5" />
                    The reset has already run for the leave year starting 1 May {preview.leaveYear}. Running it again would give everyone their full entitlement again.
                </div>
            )}
            {note && <div role="status" className="p-3 rounded-lg border bg-slate-50 text-slate-800 text-sm">{note}</div>}

            <div className="rounded-xl shadow-sm border overflow-auto max-h-[560px]" style={{ backgroundColor: "white", borderColor: "#e2e8f0" }}>
                <table className="w-full text-sm text-left">
                    <thead className="bg-slate-50 text-xs uppercase text-slate-500 sticky top-0">
                        <tr>
                            <th className="px-4 py-3">Name</th>
                            <th className="px-4 py-3">Role</th>
                            <th className="px-4 py-3 text-center">Entitlement</th>
                            <th className="px-4 py-3 text-center">Days left now</th>
                            <th className="px-4 py-3 text-center">Carry over</th>
                            <th className="px-4 py-3 text-center">New balance</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {preview.people.map(p => (
                            <tr key={p.uid}>
                                <td className="px-4 py-2 font-medium text-slate-900">{p.name}</td>
                                <td className="px-4 py-2 text-slate-500">{p.role}</td>
                                <td className="px-4 py-2 text-center font-mono">{p.entitlement}</td>
                                <td className="px-4 py-2 text-center font-mono">{p.daysLeftNow === null ? "Not set" : p.daysLeftNow}</td>
                                <td className="px-4 py-2 text-center font-mono">{p.carry}</td>
                                <td className="px-4 py-2 text-center font-mono font-bold" style={{ color: "#2c4a00" }}>{p.newBalance}</td>
                            </tr>
                        ))}
                        {preview.people.length === 0 && <tr><td colSpan={6} className="p-8 text-center text-slate-400">Nobody has leave.</td></tr>}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

// --- Main Page ---

const TAB_IDS = ["my-leave", "team", "allowances", "reset"];

export default function LeaveHubPage() {
    const { user, loading } = useAuth();
    const [activeTab, setActiveTab] = useState("my-leave");
    const [showRequestForm, setShowRequestForm] = useState(false);
    const [refreshKey, setRefreshKey] = useState(0);
    const [hasReports, setHasReports] = useState(false);

    // ?tab=team (the dashboard's "Review Requests" and the leave emails open the Team Requests tab).
    useEffect(() => {
        try {
            const t = new URLSearchParams(window.location.search).get("tab") || "";
            if (TAB_IDS.includes(t)) setActiveTab(t);
        } catch { /* ignore */ }
    }, []);

    useEffect(() => {
        if (!user) return;
        getDocs(query(collection(db, "users"), where("managerId", "==", user.uid), limit(1)))
            .then(s => setHasReports(!s.empty)).catch(() => setHasReports(false));
    }, [user?.uid]);

    if (loading || !user) return <DashboardLayout><div className="p-8">Loading...</div></DashboardLayout>;

    const isAdmin = can(user, "leave_manage");
    // 29 Sep 2026: a line manager is anyone who manages someone (users.managerId), whatever their role.
    const isManager = isAdmin || hasReports;
    const isSuper = user.role === "super_admin";

    const tabs = [
        { id: "my-leave", label: "My Leave", icon: User, visible: true },
        { id: "team", label: "Team Requests", icon: CheckCircle, visible: isManager },
        { id: "allowances", label: "Allowances", icon: FileText, visible: isAdmin },
        { id: "reset", label: "Run Yearly Reset", icon: RefreshCw, visible: isSuper },
    ].filter(t => t.visible);
    // A tab asked for in the address (or no longer allowed) falls back to My Leave until it is visible.
    const shown = tabs.some(t => t.id === activeTab) ? activeTab : "my-leave";

    const selectTab = (id: string) => {
        setActiveTab(id); setShowRequestForm(false);
        try { const url = new URL(window.location.href); url.searchParams.set("tab", id); window.history.replaceState(null, "", url.toString()); } catch { /* ignore */ }
    };

    return (
        <DashboardLayout>
            <div className="mb-8 flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-slate-800">Leave Management</h1>
                    <p className="text-slate-500">Manage your absence and review team requests.</p>
                </div>
                {shown === "my-leave" && !showRequestForm && (
                    <button onClick={() => setShowRequestForm(true)} className="flex items-center gap-2 bg-blue-600 text-white px-5 py-2.5 rounded-xl hover:bg-blue-700 transition-colors shadow-sm font-bold">
                        <PlusCircle size={20} /> Request Leave
                    </button>
                )}
            </div>

            <div className="flex gap-2 border-b border-slate-200 mb-6 overflow-x-auto pb-1" role="tablist">
                {tabs.map(tab => {
                    const Icon = tab.icon;
                    return (
                        <button
                            key={tab.id}
                            role="tab"
                            aria-selected={shown === tab.id}
                            onClick={() => selectTab(tab.id)}
                            className={cn(
                                "flex items-center gap-2 px-4 py-3 text-sm font-medium rounded-t-lg transition-colors whitespace-nowrap",
                                shown === tab.id ? "bg-white border text-blue-600 border-b-white -mb-px" : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
                            )}
                        >
                            <Icon size={18} />
                            {tab.label}
                        </button>
                    );
                })}
            </div>

            <div className="min-h-[400px]">
                {shown === "my-leave" && (
                    <div className="grid md:grid-cols-3 gap-8">
                        <div className="md:col-span-1">
                            <LeaveBalanceCard user={user} />
                        </div>
                        <div className="md:col-span-2">
                            {showRequestForm ? (
                                <RequestLeaveForm user={user} onClose={() => setShowRequestForm(false)} onSuccess={() => setRefreshKey(k => k + 1)} />
                            ) : (
                                <MyRequestsList user={user} refreshTrigger={refreshKey} />
                            )}
                        </div>
                    </div>
                )}

                {shown === "team" && isManager && (
                    <div className="max-w-4xl"><TeamRequests user={user} /></div>
                )}

                {shown === "allowances" && isAdmin && <AllowancesTable />}

                {shown === "reset" && isSuper && <YearlyResetTab />}
            </div>
        </DashboardLayout>
    );
}
