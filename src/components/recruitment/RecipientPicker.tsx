"use client";

// Tick who receives an email, and add another address (29 Sep 2026).
// Used for the interview invite, the accept / decline emails and the new application alerts.
import { useState } from "react";
import { Plus, X } from "lucide-react";

export type RecipientOption = { email: string; label: string };
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export default function RecipientPicker({ title, options, extra, ticked, onChange, note }: {
    title: string;
    options: RecipientOption[];          // fixed people (applicant, you, admins)
    extra: string[];                     // addresses added by hand (can be removed)
    ticked: string[];                    // the addresses that will receive it
    onChange: (next: { extra: string[]; ticked: string[] }) => void;
    note?: string;
}) {
    const [adding, setAdding] = useState("");
    const [err, setErr] = useState("");
    const known = new Set(options.map(o => o.email.toLowerCase()));
    const rows: (RecipientOption & { removable: boolean })[] = [
        ...options.map(o => ({ ...o, email: o.email.toLowerCase(), removable: false })),
        ...extra.filter(e => !known.has(e)).map(e => ({ email: e, label: "", removable: true })),
    ];
    const isOn = (e: string) => ticked.includes(e);
    const toggle = (e: string) => onChange({ extra, ticked: isOn(e) ? ticked.filter(t => t !== e) : [...ticked, e] });
    const add = () => {
        const e = adding.trim().toLowerCase();
        if (!EMAIL_RE.test(e)) { setErr("That is not a valid email address."); return; }
        setErr(""); setAdding("");
        onChange({ extra: known.has(e) || extra.includes(e) ? extra : [...extra, e], ticked: isOn(e) ? ticked : [...ticked, e] });
    };
    const remove = (e: string) => onChange({ extra: extra.filter(x => x !== e), ticked: ticked.filter(t => t !== e) });

    return (
        <fieldset className="rounded-lg border border-slate-200 p-3">
            <legend className="px-1 text-xs font-semibold text-slate-600">{title}</legend>
            {note && <p className="text-xs text-slate-500 mb-2">{note}</p>}
            <ul className="space-y-1">
                {rows.map(r => (
                    <li key={r.email} className="flex items-center gap-2 text-sm">
                        <label className="flex items-center gap-2 cursor-pointer min-w-0">
                            <input type="checkbox" className="h-4 w-4 accent-blue-600" checked={isOn(r.email)} onChange={() => toggle(r.email)} />
                            <span className="truncate">{r.label ? <><span className="font-medium">{r.label}</span> <span className="text-slate-500">{r.email}</span></> : r.email}</span>
                        </label>
                        {r.removable && <button type="button" onClick={() => remove(r.email)} className="text-slate-400 hover:text-red-600" aria-label={`Remove ${r.email}`}><X size={14} /></button>}
                    </li>
                ))}
            </ul>
            <div className="mt-2 flex gap-2">
                <input type="email" value={adding} onChange={e => { setAdding(e.target.value); setErr(""); }}
                    onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
                    placeholder="Add another email address" className="flex-1 min-w-0 p-1.5 border rounded text-sm" />
                <button type="button" onClick={add} className="px-2.5 py-1.5 rounded border border-slate-300 text-sm flex items-center gap-1 hover:bg-slate-50"><Plus size={14} /> Add</button>
            </div>
            {err && <p className="text-xs text-red-600 mt-1">{err}</p>}
        </fieldset>
    );
}
