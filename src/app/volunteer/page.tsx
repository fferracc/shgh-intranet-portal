"use client";

// Public volunteer application form (no login): /volunteer
// Since 29 Sep 2026 the questions come from the editable template (formTemplates/volunteer,
// edited at /recruitment/forms). Answers go to volunteer_applications; nationality,
// ethnicity, disability and any question marked private go to a private sub-document that
// only admins and people with the Volunteer Applications permission can read.
// /volunteer?preview=1 shows the form without sending anything (used by the editor).
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { collection, doc, getDoc, serverTimestamp, writeBatch } from "firebase/firestore";
import { ref, uploadBytes } from "firebase/storage";
import { db, storage } from "@/lib/firebase";
import { CV_MAX_BYTES } from "@/lib/volunteerForm";
import { Answer, buildVolunteerSubmission, checkAnswer, FormTemplate, loadTemplate } from "@/lib/formTemplates";
import FormRenderer from "@/components/forms/FormRenderer";

type Phase = "loading" | "closed" | "form" | "sending" | "done";

function VolunteerApply() {
    const preview = useSearchParams().get("preview") === "1";
    const [phase, setPhase] = useState<Phase>("loading");
    const [t, setT] = useState<FormTemplate | null>(null);
    const [values, setValues] = useState<Record<string, Answer>>({});
    const [extras, setExtras] = useState<Record<string, string>>({});
    const [cv, setCv] = useState<File | null>(null);
    const [consent, setConsent] = useState(false);
    const [honeypot, setHoneypot] = useState("");
    const [openedAt] = useState(() => Date.now());
    const [error, setError] = useState("");

    useEffect(() => {
        (async () => {
            const tpl = await loadTemplate("volunteer");
            setT(tpl);
            if (preview) { setPhase("form"); return; }
            try {
                const s = await getDoc(doc(db, "settings", "volunteerForm"));
                setPhase(s.exists() && s.data().open === false ? "closed" : "form");
            } catch { setPhase("form"); }
        })();
    }, [preview]);

    const onCv = (f: File | null) => {
        setError("");
        if (!f) { setCv(null); return; }
        if (f.type !== "application/pdf" && !f.name.toLowerCase().endsWith(".pdf")) { setError("Your CV must be a PDF file."); setCv(null); return; }
        if (f.size > CV_MAX_BYTES) { setError("Your CV is larger than 3 MB. Please upload a smaller PDF."); setCv(null); return; }
        setCv(f);
    };

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!t) return;
        setError("");
        const missing = t.questions.map(q => q.type === "cv" ? (q.required && !cv ? q.label : "") : checkAnswer(q, values[q.id], extras)).filter(Boolean);
        if (missing.length) { setError(`Please answer: ${missing.join("; ")}.`); return; }
        if (!consent) { setError("Please tick the consent box."); return; }
        if (preview) { setError("This is a preview. Nothing was sent."); return; }
        if (honeypot || Date.now() - openedAt < 4000) { setPhase("done"); return; }

        setPhase("sending");
        try {
            const appRef = doc(collection(db, "volunteer_applications"));
            const { top, priv } = buildVolunteerSubmission(t, values, extras);
            const data: Record<string, unknown> = { ...top, consent: true, status: "new", submittedAt: serverTimestamp() };
            if (cv) {
                const cvPath = `volunteerCVs/${appRef.id}/cv.pdf`;
                await uploadBytes(ref(storage, cvPath), cv, { contentType: "application/pdf" });
                data.cvPath = cvPath; data.cvName = cv.name.slice(0, 120);
            }
            const batch = writeBatch(db);
            batch.set(appRef, data);
            batch.set(doc(db, "volunteer_applications", appRef.id, "private", "equality"), priv);
            await batch.commit();
            setPhase("done");
            window.scrollTo(0, 0);
        } catch (err) {
            console.error("Volunteer application not saved", err);
            setError("Sorry, your application could not be sent. Please try again. If it keeps happening, call us on 0161 759 1255.");
            setPhase("form");
        }
    };

    const shell = (children: React.ReactNode) => (
        <div className="min-h-screen bg-slate-50 py-8 px-4">
            <div className="max-w-2xl mx-auto">
                {preview && <div className="mb-4 p-3 rounded-lg bg-amber-100 border border-amber-300 text-amber-900 text-sm font-semibold">Preview: this is how applicants see the form. Nothing you type here is sent.</div>}
                <div className="flex items-center gap-3 mb-6">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/assets/logo.png" alt="Sovereign House GH" className="h-14 w-auto" />
                    <span className="font-bold text-slate-800 text-lg">Sovereign House GH</span>
                </div>
                {children}
                <p className="text-xs text-slate-400 mt-8 text-center">Sovereign House GH. Registered Charity England and Wales 1168568.</p>
            </div>
        </div>
    );

    if (phase === "loading" || !t) return shell(<div className="bg-white rounded-xl p-8 shadow-sm text-slate-500">Loading the form…</div>);
    if (phase === "closed") return shell(
        <div className="bg-white rounded-xl p-8 shadow-sm">
            <h1 className="text-xl font-bold text-slate-800 mb-2">Volunteer applications are closed</h1>
            <p className="text-slate-600">We are not taking new volunteer applications right now. Please check sovereignhousegh.com or call us on 0161 759 1255.</p>
        </div>
    );
    if (phase === "done") return shell(
        <div className="bg-white rounded-xl p-8 shadow-sm">
            <h1 className="text-xl font-bold text-emerald-700 mb-2">Thank you, your application has been received</h1>
            <p className="text-slate-600">{t.thankYou}</p>
            <p className="text-slate-600 mt-2">We have also emailed you a copy of your application.</p>
        </div>
    );

    return shell(
        <form onSubmit={submit} className="bg-white rounded-xl shadow-sm overflow-hidden" noValidate>
            <div className="bg-emerald-700 text-white p-6">
                <h1 className="text-2xl font-bold">{t.title}</h1>
                {t.intro && <p className="mt-2 text-emerald-50 whitespace-pre-wrap">{t.intro}</p>}
            </div>
            <div className="p-6 space-y-7">
                {error && <div className="p-3 rounded-lg bg-red-50 text-red-700 border border-red-200" role="alert">{error}</div>}
                <FormRenderer template={t} values={values} extras={extras}
                    setValue={(id, v) => setValues(p => ({ ...p, [id]: v }))} setExtra={(id, v) => setExtras(p => ({ ...p, [id]: v }))}
                    cv={cv} onCv={onCv} />

                <div aria-hidden className="absolute -left-[9999px] h-0 overflow-hidden">
                    <label htmlFor="website">Website</label>
                    <input id="website" tabIndex={-1} autoComplete="off" value={honeypot} onChange={e => setHoneypot(e.target.value)} />
                </div>

                <label className="flex items-start gap-3 p-4 bg-slate-50 rounded-lg border border-slate-200 cursor-pointer">
                    <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} className="w-5 h-5 mt-0.5 accent-emerald-600" />
                    <span className="text-sm text-slate-700">{t.consent} <span className="text-red-600" aria-hidden>*</span></span>
                </label>
                {error && <div className="p-3 rounded-lg bg-red-50 text-red-700 border border-red-200" role="alert">{error}</div>}

                <button type="submit" disabled={phase === "sending"} className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-3 rounded-lg transition disabled:opacity-60">
                    {phase === "sending" ? "Sending…" : preview ? "Submit (preview, nothing is sent)" : "Submit application"}
                </button>
            </div>
        </form>
    );
}

export default function VolunteerApplyPage() {
    return <Suspense fallback={null}><VolunteerApply /></Suspense>;
}
