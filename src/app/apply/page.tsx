"use client";

// Public application form (no login). Link: /apply?p=<processId>
// The process (an "opening" in Student Applications) says which form to show and whether
// it is still open. Since 29 Sep 2026 the questions come from the editable template
// (formTemplates/<formType>, edited at /recruitment/forms). Answers are saved to
// applicationProcesses/<processId>/submissions.
// /apply?form=<children|adults|refugees|referral>&preview=1 shows a form without sending anything.
// 6 Oct 2026: a process before its "opens on" date, after its "closes on" date, or archived shows
// "not open" (the database refuses answers after closesAt in any case).
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { addDoc, collection, doc, getDoc, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { submissionsPath } from "@/lib/applicationForms";
import { Answer, buildStudentSubmission, checkAnswer, FormId, FormTemplate, loadTemplate, STUDENT_FORM_IDS } from "@/lib/formTemplates";
import FormRenderer from "@/components/forms/FormRenderer";
import { processState } from "@/lib/studentApplications";

type Phase = "loading" | "closed" | "form" | "sending" | "done";

function ApplyForm() {
    const params = useSearchParams();
    const processId = params.get("p") || "";
    const preview = params.get("preview") === "1";
    const previewForm = params.get("form") || "";
    const [phase, setPhase] = useState<Phase>("loading");
    const [t, setT] = useState<FormTemplate | null>(null);
    const [title, setTitle] = useState("");
    const [values, setValues] = useState<Record<string, Answer>>({});
    const [extras, setExtras] = useState<Record<string, string>>({});
    const [consent, setConsent] = useState(false);
    const [honeypot, setHoneypot] = useState("");
    const [openedAt] = useState(() => Date.now());
    const [errorMsg, setErrorMsg] = useState("");

    useEffect(() => {
        (async () => {
            if (preview && STUDENT_FORM_IDS.includes(previewForm as never)) {
                const tpl = await loadTemplate(previewForm as FormId);
                setT(tpl); setTitle(tpl.title); setPhase("form"); return;
            }
            if (!processId) { setPhase("closed"); return; }
            try {
                const snap = await getDoc(doc(db, "applicationProcesses", processId));
                const data = snap.exists() ? snap.data() : null;
                if (!data || !STUDENT_FORM_IDS.includes(data.formType) || processState(data) !== "open") { setPhase("closed"); return; }
                const tpl = await loadTemplate(data.formType as FormId);
                setT(tpl);
                setTitle(data.title || tpl.title);
                setPhase("form");
            } catch {
                // A closed or unknown form cannot be read by the public, which lands here.
                setPhase("closed");
            }
        })();
    }, [processId, preview, previewForm]);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!t) return;
        setErrorMsg("");
        const missing = t.questions.map(q => checkAnswer(q, values[q.id], extras)).filter(Boolean);
        if (missing.length) { setErrorMsg(`Please answer: ${missing.join("; ")}.`); return; }
        if (!consent) { setErrorMsg("Please tick the consent box."); return; }
        if (preview) { setErrorMsg("This is a preview. Nothing was sent."); return; }
        // Bots fill hidden fields and submit instantly. Pretend it worked.
        if (honeypot || Date.now() - openedAt < 3000) { setPhase("done"); return; }
        setPhase("sending");
        try {
            await addDoc(collection(db, submissionsPath(processId)), {
                ...buildStudentSubmission(t, values, extras),
                processId, formType: t.id, consent: true, status: "New", submittedAt: serverTimestamp(),
            });
            setPhase("done");
            window.scrollTo(0, 0);
        } catch (err) {
            console.error("Application not saved", err);
            setErrorMsg("Sorry, your application could not be sent. Please check your answers and try again. If it keeps happening, call us on 0161 759 1255.");
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

    if (phase === "loading") return shell(<div className="bg-white rounded-xl p-8 shadow-sm text-slate-500">Loading the form…</div>);
    if (phase === "closed" || !t) return shell(
        <div className="bg-white rounded-xl p-8 shadow-sm">
            <h1 className="text-xl font-bold text-slate-800 mb-2">This form is not open</h1>
            <p className="text-slate-600">Applications for this course are closed, or the link is not complete. Please contact us on 0161 759 1255 or visit sovereignhousegh.com for current courses.</p>
        </div>
    );
    if (phase === "done") return shell(
        <div className="bg-white rounded-xl p-8 shadow-sm">
            <h1 className="text-xl font-bold text-emerald-700 mb-2">Thank you, your application has been received</h1>
            <p className="text-slate-600">{t.thankYou}</p>
        </div>
    );

    return shell(
        <form onSubmit={submit} className="bg-white rounded-xl shadow-sm overflow-hidden" noValidate>
            <div className="bg-emerald-700 text-white p-6">
                <h1 className="text-2xl font-bold">{title}</h1>
                {t.intro && <p className="mt-2 text-emerald-50 whitespace-pre-wrap">{t.intro}</p>}
            </div>
            <div className="p-6 space-y-6">
                {errorMsg && <div className="p-3 rounded-lg bg-red-50 text-red-700 border border-red-200" role="alert">{errorMsg}</div>}
                <FormRenderer template={t} values={values} extras={extras}
                    setValue={(id, v) => setValues(p => ({ ...p, [id]: v }))} setExtra={(id, v) => setExtras(p => ({ ...p, [id]: v }))} />

                {/* Hidden from people, visible to bots. */}
                <div aria-hidden className="absolute -left-[9999px] h-0 overflow-hidden">
                    <label htmlFor="website">Website</label>
                    <input id="website" tabIndex={-1} autoComplete="off" value={honeypot} onChange={e => setHoneypot(e.target.value)} />
                </div>

                <label className="flex items-start gap-3 p-4 bg-slate-50 rounded-lg border border-slate-200 cursor-pointer">
                    <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} className="w-5 h-5 mt-0.5 accent-emerald-600" />
                    <span className="text-sm text-slate-700">{t.consent} <span className="text-red-600" aria-hidden>*</span></span>
                </label>
                {errorMsg && <div className="p-3 rounded-lg bg-red-50 text-red-700 border border-red-200" role="alert">{errorMsg}</div>}

                <button type="submit" disabled={phase === "sending"} className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-3 rounded-lg transition disabled:opacity-60">
                    {phase === "sending" ? "Sending…" : preview ? "Submit (preview, nothing is sent)" : "Submit application"}
                </button>
                <p className="text-xs text-slate-500">Questions marked * are required.</p>
            </div>
        </form>
    );
}

export default function ApplyPage() {
    return <Suspense fallback={null}><ApplyForm /></Suspense>;
}
