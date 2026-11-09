import React, { useState, useEffect } from 'react';
import { X, Sparkles, Send, Loader2, Maximize2, Minimize2, FileText, CheckCircle, AlertCircle } from 'lucide-react';
import { httpsCallable } from 'firebase/functions';
import { functions } from '@/lib/firebase';
import { useAuth } from '@/contexts/AuthContext';
import { addAiDraft, AiDraft, AiDraftKind } from '@/lib/grants/grantStore';
import { parseUkDate } from '@/lib/grants/dates';

interface PreloadedGrant {
    id?: string;
    grantName: string;
    funder: string;
    description: string;
    amount: number;
    link: string;
}

interface AIAssistantProps {
    onClose: () => void;
    preloadedGrant?: PreloadedGrant | null;
    onCreateGrantFromSummary?: (prefillData: any) => void;
    /** When a grant is open in the edit window, Auto-Fill fills that grant instead of making a new one. */
    editingGrantName?: string;
    /** Grants a result can be saved to when the assistant was not opened from one. */
    grants?: { id: string; grantName: string; funder: string }[];
    /** A saved draft opened again from the grant's list. */
    initialResult?: { kind: AiDraftKind; text: string } | null;
    onDraftSaved?: (grantId: string, drafts: AiDraft[]) => void;
}

const KIND_LABEL: Record<AiDraftKind, string> = { draft: 'Draft', summary: 'Summary', review: 'Review', idea: 'Idea' };

export function AIAssistant({ onClose, preloadedGrant, onCreateGrantFromSummary, editingGrantName, grants, initialResult, onDraftSaved }: AIAssistantProps) {
    const { user } = useAuth();
    const [activeTab, setActiveTab] = useState<'draft' | 'summarize' | 'review'>(initialResult?.kind === 'summary' ? 'summarize' : initialResult?.kind === 'review' ? 'review' : 'draft');
    // AI results are saved on the grant (1 Oct 2026): automatically when the assistant was opened
    // from a grant, or with "Save to a grant" otherwise.
    const [saveNote, setSaveNote] = useState<Record<string, { text: string; ok: boolean }>>({});
    const [saveTarget, setSaveTarget] = useState('');
    const [isExpanded, setIsExpanded] = useState(false);
    const [loading, setLoading] = useState(false);

    // Drafter State
    const [funderReqs, setFunderReqs] = useState('');
    const [suggestedIdea, setSuggestedIdea] = useState('');
    const [appForm, setAppForm] = useState('');
    const [amount, setAmount] = useState('');
    const [draftResult, setDraftResult] = useState('');
    const [ideaLoading, setIdeaLoading] = useState(false);

    // Summarizer State
    const [funderText, setFunderText] = useState('');
    const [summaryResult, setSummaryResult] = useState('');

    // Reviewer State
    const [reviewDraft, setReviewDraft] = useState('');
    const [rubric, setRubric] = useState('');
    const [reviewResult, setReviewResult] = useState('');

    useEffect(() => {
        if (!initialResult) return;
        if (initialResult.kind === 'summary') setSummaryResult(initialResult.text);
        else if (initialResult.kind === 'review') setReviewResult(initialResult.text);
        else if (initialResult.kind === 'idea') setSuggestedIdea(initialResult.text);
        else setDraftResult(initialResult.text);
    }, [initialResult]);

    const saveResult = async (kind: AiDraftKind, text: string, grantId?: string) => {
        const id = grantId || preloadedGrant?.id || '';
        if (!id || !text.trim()) return;
        const name = preloadedGrant?.id === id ? preloadedGrant.grantName : (grants || []).find(g => g.id === id)?.grantName || 'the grant';
        setSaveNote(n => ({ ...n, [kind]: { text: 'Saving to the grant…', ok: true } }));
        try {
            const list = await addAiDraft(id, kind, text, { uid: user?.uid || '', name: user?.displayName || user?.email || '' });
            setSaveNote(n => ({ ...n, [kind]: { text: `Saved to ${name}. Find it under the grant's AI drafts.`, ok: true } }));
            onDraftSaved?.(id, list);
        } catch (e: any) {
            console.error(e);
            setSaveNote(n => ({ ...n, [kind]: { text: `Not saved: ${e?.code === 'permission-denied' ? 'you need the Grants permission' : e?.message || 'unknown error'}`, ok: false } }));
        }
    };

    const SaveRow = ({ kind, text }: { kind: AiDraftKind; text: string }) => (
        <div className="space-y-1">
            {!preloadedGrant?.id && grants && grants.length > 0 && (
                <div className="flex gap-2">
                    <select className="flex-1 text-xs p-2 border border-slate-200 rounded-lg bg-white" value={saveTarget} onChange={e => setSaveTarget(e.target.value)} aria-label="Grant to save to">
                        <option value="">Choose a grant to save this to</option>
                        {grants.map(g => <option key={g.id} value={g.id}>{g.grantName} ({g.funder})</option>)}
                    </select>
                    <button disabled={!saveTarget} onClick={() => saveResult(kind, text, saveTarget)} className="text-xs font-semibold px-3 py-2 rounded-lg bg-slate-900 text-white disabled:opacity-40">Save to the grant</button>
                </div>
            )}
            {saveNote[kind] && <p role="status" className={`text-xs ${saveNote[kind].ok ? 'text-emerald-700' : 'text-red-600'}`}>{saveNote[kind].text}</p>}
        </div>
    );

    // Pre-fill Drafter when a grant is selected from the table
    useEffect(() => {
        if (preloadedGrant) {
            setActiveTab('draft');
            const reqParts: string[] = [];
            if (preloadedGrant.funder) reqParts.push(`Funder: ${preloadedGrant.funder}`);
            if (preloadedGrant.grantName) reqParts.push(`Grant: ${preloadedGrant.grantName}`);
            if (preloadedGrant.description) reqParts.push(`Details: ${preloadedGrant.description}`);
            if (preloadedGrant.link) reqParts.push(`Website: ${preloadedGrant.link}`);
            setFunderReqs(reqParts.join('\n'));
            if (preloadedGrant.amount) setAmount(preloadedGrant.amount.toString());
        }
    }, [preloadedGrant]);

    const handleCallAI = async (action: string, payload: any) => {
        try {
            const isDev = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
            
            if (isDev) {
                const response = await fetch('/api/ai-grants', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ action, payload })
                });
                if (!response.ok) {
                    const errData = await response.json().catch(() => ({}));
                    throw new Error(errData.error || `HTTP error! status: ${response.status}`);
                }
                const data = await response.json();
                if (data.error) throw new Error(data.error);
                return data.result;
            } else {
                const aiGrantsCallable = httpsCallable(functions, 'aiGrants');
                const response = await aiGrantsCallable({ action, payload });
                const data = response.data as { result: any, error?: string };
                if (data.error) throw new Error(data.error);
                return data.result;
            }
        } catch (error: any) {
            console.error(error);
            const errorMessage = error.message || "Unknown error";
            if (errorMessage.includes("503") || errorMessage.includes("high demand") || errorMessage.includes("temporarily overloaded")) {
                alert("The AI service is currently experiencing high demand and is temporarily unavailable. We've tried reconnecting automatically, but please try again in a few moments if it continues to fail.");
            } else {
                alert(`AI generation failed: ${errorMessage}`);
            }
            return null;
        }
    };

    const handleSuggestIdea = async () => {
        if (!funderReqs) return alert("Please enter the funder requirements first.");
        setIdeaLoading(true);
        const res = await handleCallAI('suggest_idea', { funderRequirements: funderReqs });
        if (res) setSuggestedIdea(res);
        setIdeaLoading(false);
    };

    const handleGenerateDraft = async () => {
        if (!suggestedIdea || !appForm || !amount) return alert("Please fill in the Idea, the Application Form, and Funding Amount.");
        setLoading(true);
        const res = await handleCallAI('generate_draft', {
            funderRequirements: funderReqs,
            acceptedIdea: suggestedIdea,
            applicationForm: appForm,
            amount
        });
        if (res) { setDraftResult(res); saveResult('draft', res); }
        setLoading(false);
    };

    const handleSummarize = async () => {
        if (!funderText) return alert("Please enter text to summarize.");
        setLoading(true);
        const res = await handleCallAI('summarize', { funderText });
        if (res) { setSummaryResult(res); saveResult('summary', res); }
        setLoading(false);
    };

    const handleReview = async () => {
        if (!reviewDraft || !rubric) return alert("Please provide both the draft and the rubric.");
        setLoading(true);
        const res = await handleCallAI('review', { draft: reviewDraft, rubric });
        if (res) { setReviewResult(res); saveResult('review', res); }
        setLoading(false);
    };

    const parseSummaryForGrant = () => {
        if (!summaryResult) return;

        const prefill: any = {
            description: summaryResult
        };

        // Try to parse Amount (looking for £ followed by numbers/commas)
        const amountMatch = summaryResult.match(/£\s*([\d,]+)/);
        if (amountMatch) {
            prefill.amount = parseInt(amountMatch[1].replace(/,/g, ''), 10);
        }

        // The deadline, read the UK way (1 Oct 2026): 01/07/2026 is 1 July, kept as 'YYYY-MM-DD'
        // so it never moves by a day. The line after "Deadline:" is tried too.
        const lines = summaryResult.split('\n');
        const at = lines.findIndex(line => line.toLowerCase().includes('deadline'));
        if (at >= 0) {
            const ymd = parseUkDate(lines[at]) || parseUkDate(lines[at + 1] || '');
            if (ymd) prefill.deadline = ymd;
        }

        // Funder name might be in the original prompt if it was a URL
        if (funderText.includes('http')) {
            try {
                const url = new URL(funderText);
                prefill.funder = url.hostname.replace('www.', '');
                prefill.link = funderText;
            } catch (e) {
                // Ignore
            }
        }

        // Funder Name extraction from the new prompt
        const funderMatch = summaryResult.match(/\*\*Funder Name:\*\*\s*(.+)/i) || summaryResult.match(/Funder Name:\s*(.+)/i);
        if (funderMatch && funderMatch[1]) {
            const extractedName = funderMatch[1].trim();
            // Don't override if it's just a placeholder or empty
            if (extractedName && !extractedName.includes('Extract the name')) {
                prefill.funder = extractedName.replace(/^[*-]\s*/, ''); // Remove leading bullets if any
            }
        }

        if (onCreateGrantFromSummary) {
            onCreateGrantFromSummary(prefill);
            onClose(); // Auto close the assistant
        }
    };


    return (
        <div className={`fixed bottom-4 right-4 bg-white shadow-2xl rounded-2xl border border-slate-200 overflow-hidden flex flex-col z-50 transition-all duration-300 ${isExpanded ? 'w-[800px] h-[80vh]' : 'w-[450px] h-[600px]'}`}>
            {/* Header */}
            <div className="bg-slate-900 text-white p-4 flex justify-between items-center cursor-default shrink-0">
                <div className="flex items-center gap-2 font-bold flex-1">
                    <Sparkles className="h-5 w-5 text-purple-400" />
                    AI Grants Assistant
                    {preloadedGrant && (
                        <span className="text-xs font-normal bg-purple-500/20 text-purple-300 px-2 py-0.5 rounded-full ml-1">
                            {preloadedGrant.grantName}
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    <button onClick={() => setIsExpanded(!isExpanded)} className="p-1.5 hover:bg-white/10 rounded-lg transition-colors text-slate-300 hover:text-white">
                        {isExpanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                    </button>
                    <button onClick={onClose} className="p-1.5 hover:bg-white/10 rounded-lg transition-colors text-slate-300 hover:text-white">
                        <X size={18} />
                    </button>
                </div>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-slate-200 bg-slate-50 shrink-0">
                <button
                    onClick={() => setActiveTab('draft')}
                    className={`flex-1 py-3 text-sm font-semibold transition-colors border-b-2 ${activeTab === 'draft' ? 'border-purple-600 text-purple-700 bg-purple-50/50' : 'border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-100'}`}
                >
                    Draft Writer
                </button>
                <button
                    onClick={() => setActiveTab('summarize')}
                    className={`flex-1 py-3 text-sm font-semibold transition-colors border-b-2 ${activeTab === 'summarize' ? 'border-purple-600 text-purple-700 bg-purple-50/50' : 'border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-100'}`}
                >
                    Summarizer
                </button>
                <button
                    onClick={() => setActiveTab('review')}
                    className={`flex-1 py-3 text-sm font-semibold transition-colors border-b-2 ${activeTab === 'review' ? 'border-purple-600 text-purple-700 bg-purple-50/50' : 'border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-100'}`}
                >
                    Reviewer
                </button>
            </div>

            {/* Content Area */}
            <div className="flex-1 overflow-y-auto p-5 custom-scrollbar bg-slate-50/30">
                {/* DRAFTER TAB */}
                {activeTab === 'draft' && (
                    <div className="space-y-6">
                        {preloadedGrant && (
                            <div className="p-3 bg-purple-50 border border-purple-200 rounded-xl text-xs text-purple-700">
                                <strong>Pre-loaded from table:</strong> {preloadedGrant.grantName} ({preloadedGrant.funder}). Fields below have been auto-filled.{preloadedGrant.id ? ' Every draft, summary and review is saved on this grant.' : ''}
                            </div>
                        )}
                        {initialResult && <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-600">Opened a saved {KIND_LABEL[initialResult.kind].toLowerCase()}.</div>}
                        <div className="space-y-2">
                            <label className="text-xs font-bold text-slate-500 uppercase">1. Funder Requirements / Aims</label>
                            <textarea
                                className="w-full text-sm p-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-purple-500/20 active:outline-none min-h-[100px] resize-y custom-scrollbar"
                                placeholder="Paste the funder's aims or core requirements here..."
                                value={funderReqs}
                                onChange={(e) => setFunderReqs(e.target.value)}
                            />
                            <button
                                onClick={handleSuggestIdea}
                                disabled={ideaLoading || !funderReqs}
                                className="w-full mt-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-semibold py-2.5 rounded-lg transition-colors flex justify-center items-center gap-2 border border-slate-300 disabled:opacity-50"
                            >
                                {ideaLoading ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} className="text-purple-600" />}
                                Suggest Aligned Idea
                            </button>
                        </div>

                        {suggestedIdea && (
                            <div className="space-y-2 animate-in fade-in slide-in-from-top-2 duration-300">
                                <label className="text-xs font-bold text-slate-500 uppercase">2. Suggested Project Idea (Edit as needed)</label>
                                <textarea
                                    className="w-full text-sm p-3 border border-purple-200 bg-purple-50/30 rounded-xl focus:ring-2 focus:ring-purple-500/20 active:outline-none min-h-[120px] resize-y custom-scrollbar"
                                    value={suggestedIdea}
                                    onChange={(e) => setSuggestedIdea(e.target.value)}
                                />
                            </div>
                        )}

                        <div className="space-y-2">
                            <label className="text-xs font-bold text-slate-500 uppercase">3. Application Form Questions</label>
                            <textarea
                                className="w-full text-sm p-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-purple-500/20 active:outline-none min-h-[150px] resize-y custom-scrollbar"
                                placeholder="Paste the exact application questions here (include word limits)..."
                                value={appForm}
                                onChange={(e) => setAppForm(e.target.value)}
                            />
                        </div>

                        <div className="space-y-2">
                            <label className="text-xs font-bold text-slate-500 uppercase">4. Total Amount Requested (£)</label>
                            <input
                                type="number"
                                className="w-full text-sm p-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-purple-500/20 outline-none"
                                placeholder="e.g. 5000"
                                value={amount}
                                onChange={(e) => setAmount(e.target.value)}
                            />
                        </div>

                        <button
                            onClick={handleGenerateDraft}
                            disabled={loading || !suggestedIdea || !appForm || !amount}
                            className="w-full bg-purple-600 hover:bg-purple-700 text-white text-sm font-bold py-3 rounded-xl transition-colors shadow-sm flex items-center justify-center gap-2 disabled:opacity-50"
                        >
                            {loading ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
                            Generate Full Draft & Budget
                        </button>

                        {draftResult && (
                            <div className="mt-8 pt-6 border-t border-slate-200 space-y-3 animate-in fade-in">
                                <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2"><CheckCircle size={16} className="text-green-500" /> Generated Draft</h3>
                                <div className="p-4 bg-white border border-slate-200 rounded-xl text-sm prose prose-sm max-w-none text-slate-700 custom-scrollbar overflow-x-auto whitespace-pre-wrap">
                                    {draftResult}
                                </div>
                                <button onClick={() => navigator.clipboard?.writeText(draftResult)} className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50">Copy the draft</button>
                                <SaveRow kind="draft" text={draftResult} />
                            </div>
                        )}
                    </div>
                )}

                {/* SUMMARIZER TAB */}
                {activeTab === 'summarize' && (
                    <div className="space-y-6 h-full flex flex-col">
                        <div className="space-y-2 flex-shrink-0">
                            <label className="text-xs font-bold text-slate-500 uppercase">Paste Funder Details or URL</label>
                            <textarea
                                className="w-full text-sm p-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-purple-500/20 active:outline-none min-h-[150px] resize-y custom-scrollbar"
                                placeholder="Paste the long text from the funder's website or guidelines here, or a link to the funder..."
                                value={funderText}
                                onChange={(e) => setFunderText(e.target.value)}
                            />
                            <button
                                onClick={handleSummarize}
                                disabled={loading || !funderText}
                                className="w-full bg-purple-600 hover:bg-purple-700 text-white text-sm font-bold py-3 rounded-xl transition-colors shadow-sm flex items-center justify-center gap-2 disabled:opacity-50"
                            >
                                {loading ? <Loader2 size={18} className="animate-spin" /> : <FileText size={18} />}
                                Extract Key Details
                            </button>
                        </div>

                        {summaryResult && (
                            <div className="mt-4 flex-1 flex flex-col min-h-0 space-y-3 animate-in fade-in pb-2">
                                <h3 className="text-sm font-bold text-slate-800 shrink-0">Extraction Result</h3>
                                <div className="flex-1 p-4 bg-yellow-50/50 border border-yellow-200 rounded-xl text-sm prose prose-sm max-w-none text-slate-800 custom-scrollbar overflow-y-auto whitespace-pre-wrap">
                                    {summaryResult}
                                </div>
                                {onCreateGrantFromSummary && (
                                    <button
                                        onClick={parseSummaryForGrant}
                                        className="w-full mt-2 bg-slate-900 hover:bg-slate-800 text-white text-sm font-bold py-2.5 rounded-xl transition-colors shadow-sm flex items-center justify-center gap-2 shrink-0"
                                    >
                                        <Sparkles size={16} className="text-yellow-400" />
                                        {editingGrantName ? `Fill in ${editingGrantName}` : 'Create Grant from Summary'}
                                    </button>
                                )}
                                <SaveRow kind="summary" text={summaryResult} />
                            </div>
                        )}
                    </div>
                )}

                {/* REVIEWER TAB */}
                {activeTab === 'review' && (
                    <div className="space-y-6 flex flex-col h-full">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 shrink-0">
                            <div className="space-y-2">
                                <label className="text-xs font-bold text-slate-500 uppercase">Scoring Rubric / Criteria</label>
                                <textarea
                                    className="w-full text-sm p-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-purple-500/20 active:outline-none min-h-[150px] custom-scrollbar"
                                    placeholder="Paste how they will score the application..."
                                    value={rubric}
                                    onChange={(e) => setRubric(e.target.value)}
                                />
                            </div>
                            <div className="space-y-2">
                                <label className="text-xs font-bold text-slate-500 uppercase">Your Draft Answer</label>
                                <textarea
                                    className="w-full text-sm p-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-purple-500/20 active:outline-none min-h-[150px] custom-scrollbar"
                                    placeholder="Paste your written application here..."
                                    value={reviewDraft}
                                    onChange={(e) => setReviewDraft(e.target.value)}
                                />
                            </div>
                        </div>

                        <button
                            onClick={handleReview}
                            disabled={loading || !reviewDraft || !rubric}
                            className="w-full bg-purple-600 hover:bg-purple-700 text-white text-sm font-bold py-3 rounded-xl transition-colors shadow-sm flex items-center justify-center gap-2 shrink-0 disabled:opacity-50"
                        >
                            {loading ? <Loader2 size={18} className="animate-spin" /> : <AlertCircle size={18} />}
                            Critique Output
                        </button>

                        {reviewResult && (
                            <div className="mt-4 flex-1 min-h-0 flex flex-col space-y-3 animate-in fade-in pb-4">
                                <h3 className="text-sm font-bold text-slate-800 shrink-0">Harsh Critique</h3>
                                <div className="flex-1 p-4 bg-red-50/30 border border-red-100 rounded-xl text-sm prose prose-sm max-w-none text-slate-800 custom-scrollbar overflow-y-auto whitespace-pre-wrap">
                                    {reviewResult}
                                </div>
                                <SaveRow kind="review" text={reviewResult} />
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
