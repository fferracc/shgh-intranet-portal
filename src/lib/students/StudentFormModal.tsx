"use client";

// Add / Edit student, used by the Students list and the student page (1 Oct 2026).
import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import {
    emptyStudentForm, ETHNICITY_GROUPS, formFromStudent, isOldEthnicity, isOldNationality, keyLabel,
    NATIONALITIES, REASONS, SYSTEM_KEYS, StudentFormValues,
} from "./studentForm";
import { saveStudentForm, SaveResult } from "./saveStudent";

export default function StudentFormModal({ open, student, withPrivate, onClose, onSaved }: {
    open: boolean;
    /** The student to edit (with private fields overlaid), or null to add a new one. */
    student: Record<string, any> | null;
    /** May this person see and change the private fields (dob, GP, ethnicity, nationality, refugee number)? */
    withPrivate: boolean;
    onClose: () => void;
    onSaved: (result: SaveResult) => void;
}) {
    const [f, setF] = useState<StudentFormValues>(emptyStudentForm());
    const [newCustomField, setNewCustomField] = useState("");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        if (!open) return;
        setF(student ? formFromStudent(student) : emptyStudentForm());
        setNewCustomField(""); setError(""); setSaving(false);
    }, [open, student]);

    if (!open) return null;
    const set = (patch: Partial<StudentFormValues>) => setF(prev => ({ ...prev, ...patch }));
    const editing = !!(student && student.id);

    const addCustom = () => {
        const key = newCustomField.trim();
        if (!key) return;
        if (SYSTEM_KEYS.has(key) || /[./\[\]*`~]/.test(key)) { setError("That field name cannot be used. Try another name without dots or slashes."); return; }
        setError("");
        set({ custom: { ...f.custom, [key]: f.custom[key] ?? "" } });
        setNewCustomField("");
    };

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!f.name.trim()) { setError("Please give the student's full name."); return; }
        setSaving(true); setError("");
        try {
            const res = await saveStudentForm(editing ? String(student!.id) : null, f, withPrivate);
            if (!res.privateSaved) alert("The student was saved, but the private details (date of birth, GP, ethnicity, nationality, refugee number) could not be saved. You may not have permission.");
            onSaved(res);
        } catch (err) {
            console.error("Error saving student:", err);
            setError("The student could not be saved. You may not have permission.");
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto">
                <div className="flex justify-between items-center p-6 border-b border-slate-100 sticky top-0 bg-white z-10">
                    <h3 className="font-bold text-xl text-slate-800">{editing ? "Edit Student" : "Add New Student"}</h3>
                    <button type="button" onClick={onClose} aria-label="Close"><X size={24} className="text-slate-400" /></button>
                </div>
                <form onSubmit={submit} className="p-6 space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-medium mb-1">Full Name</label>
                            <input required type="text" className="w-full p-2 border rounded" value={f.name} onChange={e => set({ name: e.target.value })} />
                        </div>
                        <div>
                            <label className="block text-sm font-medium mb-1">Email</label>
                            <input type="email" className="w-full p-2 border rounded" value={f.email} onChange={e => set({ email: e.target.value })} />
                        </div>
                        <div>
                            <label className="block text-sm font-medium mb-1">Age</label>
                            <input required type="number" min={0} max={120} className="w-full p-2 border rounded" value={f.age} onChange={e => set({ age: Number(e.target.value) })} />
                        </div>
                        <div>
                            <label className="block text-sm font-medium mb-1">Postcode</label>
                            <input type="text" className="w-full p-2 border rounded" value={f.postcode} onChange={e => set({ postcode: e.target.value })} />
                        </div>
                        <div>
                            <label className="block text-sm font-medium mb-1">Mobile</label>
                            <input type="tel" className="w-full p-2 border rounded" value={f.mobile} onChange={e => set({ mobile: e.target.value })} />
                        </div>
                        <div>
                            <label className="block text-sm font-medium mb-1">IT Level</label>
                            <select className="w-full p-2 border rounded bg-white" value={f.itLevel} onChange={e => set({ itLevel: e.target.value })}>
                                <option value="">Select IT Level</option>
                                {f.itLevel && !["beginner", "intermediate", "advanced"].includes(f.itLevel) && <option value={f.itLevel}>{f.itLevel}</option>}
                                <option value="beginner">Beginner</option>
                                <option value="intermediate">Intermediate</option>
                                <option value="advanced">Advanced</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-sm font-medium mb-1">SH Reference Number</label>
                            <input type="text" className="w-full p-2 border rounded" value={f.sovereignReference} onChange={e => set({ sovereignReference: e.target.value })} />
                        </div>
                    </div>

                    {withPrivate ? (
                        <div className="bg-slate-50 p-4 rounded-lg space-y-4">
                            <h4 className="font-bold text-slate-700">Private details</h4>
                            <p className="text-xs text-slate-500">Only people with the Students permission can see these.</p>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-medium mb-1">Date of Birth</label>
                                    <input type="date" className="w-full p-2 border rounded bg-white" value={f.dob} onChange={e => set({ dob: e.target.value })} />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium mb-1">Nationality</label>
                                    <select className="w-full p-2 border rounded bg-white" value={f.nationality} onChange={e => set({ nationality: e.target.value })}>
                                        <option value="">Select Nationality</option>
                                        {isOldNationality(f.nationality) && <option value={f.nationality}>{f.nationality} (old answer, please choose a country)</option>}
                                        {NATIONALITIES.map(c => <option key={c} value={c}>{c}</option>)}
                                    </select>
                                    {isOldNationality(f.nationality) && <p className="text-xs text-amber-700 mt-1">This was saved before the country list. Please choose the country if you know it.</p>}
                                </div>
                                <div>
                                    <label className="block text-sm font-medium mb-1">Ethnicity</label>
                                    <select className="w-full p-2 border rounded bg-white" value={f.ethnicity} onChange={e => set({ ethnicity: e.target.value })}>
                                        <option value="">Select Ethnicity</option>
                                        {isOldEthnicity(f.ethnicity) && <option value={f.ethnicity}>{f.ethnicity}</option>}
                                        {ETHNICITY_GROUPS.map(g => (
                                            <optgroup key={g.label} label={g.label}>
                                                {g.options.map(o => <option key={o} value={o}>{o}</option>)}
                                            </optgroup>
                                        ))}
                                        <option value="Prefer not to say">Prefer not to say</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-sm font-medium mb-1">Refugee Number</label>
                                    <input type="text" className="w-full p-2 border rounded bg-white" value={f.refugeeNumber} onChange={e => set({ refugeeNumber: e.target.value })} />
                                </div>
                                <div className="sm:col-span-2">
                                    <label className="block text-sm font-medium mb-1">GP Name / Address</label>
                                    <input type="text" className="w-full p-2 border rounded bg-white" value={f.gpName} onChange={e => set({ gpName: e.target.value })} />
                                </div>
                            </div>
                        </div>
                    ) : (
                        <p className="text-xs text-slate-500 bg-slate-50 p-3 rounded-lg">Date of birth, nationality, ethnicity, GP and refugee number are private. You need the Students permission to see or change them.</p>
                    )}

                    <div>
                        <label className="block text-sm font-medium mb-1">Reason for Joining</label>
                        <select className="w-full p-2 border rounded bg-white mb-2" value={f.reason} onChange={e => set({ reason: e.target.value })}>
                            <option value="">Select a reason</option>
                            {f.reason && !REASONS.includes(f.reason) && <option value={f.reason}>{f.reason}</option>}
                            {REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                        </select>
                    </div>

                    <div className="bg-slate-50 p-4 rounded-lg space-y-4">
                        <h4 className="font-bold text-slate-700">Guardian / Emergency (If under 18)</h4>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <input placeholder="Parent Name" className="w-full p-2 border rounded bg-white" value={f.parentName} onChange={e => set({ parentName: e.target.value })} />
                            <input placeholder="Parent Phone" className="w-full p-2 border rounded bg-white" value={f.parentPhone} onChange={e => set({ parentPhone: e.target.value })} />
                            <input placeholder="Emergency Contact" className="w-full p-2 border rounded bg-white sm:col-span-2" value={f.emergencyContact} onChange={e => set({ emergencyContact: e.target.value })} />
                        </div>
                        <input placeholder="Allergies / Medical Conditions" className="w-full p-2 border rounded bg-white" value={f.allergies} onChange={e => set({ allergies: e.target.value })} />
                        <div className="flex items-center gap-2">
                            <input type="checkbox" id="photoConsent" checked={f.photoConsent} onChange={e => set({ photoConsent: e.target.checked })} />
                            <label htmlFor="photoConsent" className="text-sm">Photo Consent Granted</label>
                        </div>
                    </div>

                    <div className="bg-slate-50 p-4 rounded-lg space-y-4">
                        <h4 className="font-bold text-slate-700">Additional Information</h4>
                        {Object.keys(f.custom).length > 0 && (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                {Object.keys(f.custom).map(key => (
                                    <div key={key}>
                                        <label className="block text-sm font-medium mb-1">{keyLabel(key)}</label>
                                        <input type="text" className="w-full p-2 border rounded bg-white" value={f.custom[key] || ""} onChange={e => set({ custom: { ...f.custom, [key]: e.target.value } })} />
                                    </div>
                                ))}
                            </div>
                        )}
                        <div className="flex items-center gap-2 border-t pt-4">
                            <input placeholder="New Custom Field Name" className="flex-1 p-2 border rounded text-sm bg-white" value={newCustomField} onChange={e => setNewCustomField(e.target.value)} />
                            <button type="button" onClick={addCustom} className="bg-slate-200 text-slate-700 px-4 py-2 rounded text-sm hover:bg-slate-300 transition flex items-center gap-1"><Plus size={16} /> Add Field</button>
                        </div>
                    </div>

                    {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
                    <div className="flex justify-end gap-2 pt-4">
                        <button type="button" onClick={onClose} className="px-4 py-2 text-slate-600 font-medium hover:bg-slate-100 rounded-lg transition">Cancel</button>
                        <button type="submit" disabled={saving} className="bg-blue-600 text-white px-6 py-2 rounded-lg font-bold hover:bg-blue-700 disabled:opacity-60">{saving ? "Saving…" : "Save Student"}</button>
                    </div>
                </form>
            </div>
        </div>
    );
}
