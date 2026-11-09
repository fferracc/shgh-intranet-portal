"use client";

import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Sparkles, Loader2, CheckCircle2, Circle, ChevronDown, ChevronRight, Trash2, Plus, Award, CheckCheck } from 'lucide-react';
import { httpsCallable } from 'firebase/functions';
import { functions } from '@/lib/firebase';
import { useAuth } from '@/contexts/AuthContext';
import { cleanMilestone, Milestone, saveMilestones } from '@/lib/grants/grantStore';
import { formatUkDate, londonToday, ymdToLocalDate } from '@/lib/grants/dates';

interface GrantedGrant {
    id: string;
    grantName: string;
    funder: string;
    amount: number;
    deadline: string | null;
    status: string;
    description: string;
    grantProgress?: string;
    amountRequested?: number;
    index?: number;
    milestones?: Milestone[];
}

interface GrantedProjectsChartProps {
    grants: GrantedGrant[];
    onStatusChange: (grantId: string, newStatus: string) => Promise<void>;
    isFinalisedView?: boolean;
}

// Milestones are saved on the grant in Firestore (1 Oct 2026), so everyone sees the same ones.
// Typing is saved a moment after the last key press; the old browser-only copies are moved
// once by moveBrowserMilestones (src/lib/grants/grantStore.ts).

function GrantProjectCard({ grant, onStatusChange }: { grant: GrantedGrant; onStatusChange: (id: string, status: string) => Promise<void> }) {
    const [expanded, setExpanded] = useState(true);
    const [milestones, setMilestones] = useState<Milestone[]>([]);
    const [aiLoading, setAiLoading] = useState(false);
    const [showPasteBox, setShowPasteBox] = useState(false);
    const [pasteContent, setPasteContent] = useState('');
    const [confirmFinalise, setConfirmFinalise] = useState(false);
    const [confirmUnfinalise, setConfirmUnfinalise] = useState(false);
    const { user } = useAuth();
    const [saveState, setSaveState] = useState<{ s: 'idle' | 'saving' | 'saved' | 'error'; why?: string }>({ s: 'idle' });
    const pending = useRef<Milestone[] | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const who = { uid: user?.uid || '', name: user?.displayName || user?.email || '' };
    const whoRef = useRef(who);
    whoRef.current = who;

    useEffect(() => {
        const loaded = (grant.milestones || []).map(cleanMilestone);
        setMilestones(loaded);
        // If no milestones, automatically show the paste box
        if (loaded.length === 0) setShowPasteBox(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [grant.id]);

    const flush = async () => {
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
        const list = pending.current;
        if (!list) return;
        pending.current = null;
        setSaveState({ s: 'saving' });
        try { await saveMilestones(grant.id, list, whoRef.current); setSaveState({ s: 'saved' }); }
        catch (e) {
            console.error(e);
            const code = (e as { code?: string })?.code;
            setSaveState({ s: 'error', why: code === 'permission-denied' ? 'you need the Grants permission' : code === 'unavailable' ? 'no connection' : ((e as { message?: string })?.message || 'unknown error') });
        }
    };
    // Save what is waiting when the card closes or the page changes.
    useEffect(() => () => { if (pending.current) { const l = pending.current; pending.current = null; saveMilestones(grant.id, l, whoRef.current).catch(e => console.error(e)); } }, [grant.id]);

    const updateAndSave = (updated: Milestone[]) => {
        setMilestones(updated);
        pending.current = updated;
        setSaveState({ s: 'saving' });
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(flush, 800);
    };

    const handleGenerateMilestones = async () => {
        if (!pasteContent.trim()) return alert('Please paste the funding content first.');
        if (milestones.length && !confirm('Replace the current milestones with new ones from the AI?')) return;
        setAiLoading(true);
        try {
            const isDev = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

            if (isDev) {
                const response = await fetch('/api/ai-grants', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        action: 'generate_milestones',
                        payload: {
                            fundingContent: pasteContent,
                            grantName: grant.grantName,
                            amount: grant.amount
                        }
                    })
                });
                if (!response.ok) {
                    const errData = await response.json().catch(() => ({}));
                    throw new Error(errData.error || `HTTP error! status: ${response.status}`);
                }
                const data = await response.json();
                if (data.error) throw new Error(data.error);
                if (Array.isArray(data.result)) {
                    updateAndSave(data.result.map(cleanMilestone));
                    setShowPasteBox(false);
                } else {
                    alert('AI returned unexpected format. Please try again.');
                }
            } else {
                const aiGrantsCallable = httpsCallable(functions, 'aiGrants');
                const response = await aiGrantsCallable({
                    action: 'generate_milestones',
                    payload: {
                        fundingContent: pasteContent,
                        grantName: grant.grantName,
                        amount: grant.amount
                    }
                });
                const data = response.data as { result: any, error?: string };
                if (data.error) throw new Error(data.error);
                if (Array.isArray(data.result)) {
                    updateAndSave(data.result.map(cleanMilestone));
                    setShowPasteBox(false);
                } else {
                    alert('AI returned unexpected format. Please try again.');
                }
            }
        } catch (err: any) {
            console.error(err);
            alert('Failed to generate milestones: ' + err.message);
        } finally {
            setAiLoading(false);
        }
    };

    const toggleMilestoneComplete = (idx: number) => {
        const updated = [...milestones];
        updated[idx] = { ...updated[idx], completed: !updated[idx].completed };
        updateAndSave(updated);
    };

    const updateMilestoneName = (idx: number, name: string) => {
        const updated = [...milestones];
        updated[idx] = { ...updated[idx], milestone: name };
        updateAndSave(updated);
    };

    const updateMilestoneDate = (idx: number, date: string) => {
        const updated = [...milestones];
        updated[idx] = { ...updated[idx], date };
        updateAndSave(updated);
    };

    const updateTask = (mIdx: number, tIdx: number, value: string) => {
        const updated = [...milestones];
        updated[mIdx] = { ...updated[mIdx], tasks: [...updated[mIdx].tasks] };
        updated[mIdx].tasks[tIdx] = value;
        updateAndSave(updated);
    };

    const addTask = (mIdx: number) => {
        const updated = [...milestones];
        updated[mIdx] = { ...updated[mIdx], tasks: [...updated[mIdx].tasks, 'New task'] };
        updateAndSave(updated);
    };

    const removeTask = (mIdx: number, tIdx: number) => {
        const updated = [...milestones];
        updated[mIdx] = { ...updated[mIdx], tasks: updated[mIdx].tasks.filter((_, i) => i !== tIdx) };
        updateAndSave(updated);
    };

    const addMilestone = () => {
        const today = londonToday();
        updateAndSave([...milestones, { milestone: 'New Milestone', date: today, tasks: ['Task 1'], completed: false }]);
    };

    const removeMilestone = (idx: number) => {
        updateAndSave(milestones.filter((_, i) => i !== idx));
    };

    const handleFinalise = async () => {
        await onStatusChange(grant.id, 'Finalised');
        setConfirmFinalise(false);
    };

    const handleUnfinalise = async () => {
        await onStatusChange(grant.id, 'In process');
        setConfirmUnfinalise(false);
    };

    // Timeline calculations
    const now = new Date();
    const timelineStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const timelineEnd = new Date(now.getFullYear(), now.getMonth() + 12, 0);
    const totalMs = timelineEnd.getTime() - timelineStart.getTime();
    const nowPct = ((now.getTime() - timelineStart.getTime()) / totalMs) * 100;

    const months: { label: string; left: number }[] = [];
    const mc = new Date(timelineStart.getFullYear(), timelineStart.getMonth(), 1);
    while (mc <= timelineEnd) {
        const pct = ((mc.getTime() - timelineStart.getTime()) / totalMs) * 100;
        months.push({ label: mc.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }), left: pct });
        mc.setMonth(mc.getMonth() + 1);
    }

    const progress = milestones.length > 0
        ? Math.round((milestones.filter(m => m.completed).length / milestones.length) * 100)
        : 0;

    return (
        <div className="bg-white rounded-lg border shadow-sm overflow-hidden">
            {/* Card Header */}
            <div className="px-5 py-3 border-b bg-slate-50 flex items-center gap-3">
                <button onClick={() => setExpanded(!expanded)} className="p-0.5 hover:bg-slate-200 rounded text-slate-500">
                    {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>
                <Award className="h-4 w-4 text-green-600" />
                <div className="flex-1 min-w-0">
                    <span className="text-sm font-bold text-slate-800">
                        {grant.index ? `${grant.index}. ` : ''}{grant.grantName}
                    </span>
                    <span className="text-xs text-slate-500 ml-2">
                        {grant.funder}, £{(grant.amountRequested || grant.amount).toLocaleString()}
                        {grant.amountRequested && grant.amountRequested !== grant.amount ? ` (Requested)` : ''}
                    </span>
                </div>
                {/* Progress */}
                <div className="flex items-center gap-2">
                    <div className="w-20 h-2 bg-slate-200 rounded-full overflow-hidden">
                        <div className="h-full bg-green-500 rounded-full transition-all" style={{ width: `${progress}%` }} />
                    </div>
                    <span className="text-[10px] text-slate-500 font-semibold w-8">{progress}%</span>
                </div>
                {/* Finalise / Unfinalise */}
                {grant.grantProgress !== 'Finalised' ? (
                    !confirmFinalise ? (
                        <button
                            onClick={(e) => { e.stopPropagation(); setConfirmFinalise(true); }}
                            className="text-[10px] bg-emerald-50 text-emerald-700 border border-emerald-200 px-2.5 py-1 rounded-full font-semibold hover:bg-emerald-100 transition-colors flex items-center gap-1"
                        >
                            <CheckCheck size={12} />
                            Mark Finalised
                        </button>
                    ) : (
                        <div className="flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
                            <span className="text-[10px] text-slate-500">Sure?</span>
                            <button onClick={handleFinalise} className="text-[10px] bg-green-600 text-white px-2 py-0.5 rounded font-semibold hover:bg-green-700">Yes</button>
                            <button onClick={() => setConfirmFinalise(false)} className="text-[10px] bg-slate-200 text-slate-600 px-2 py-0.5 rounded font-semibold hover:bg-slate-300">No</button>
                        </div>
                    )
                ) : (
                    !confirmUnfinalise ? (
                        <button
                            onClick={(e) => { e.stopPropagation(); setConfirmUnfinalise(true); }}
                            className="text-[10px] bg-amber-50 text-amber-700 border border-amber-200 px-2.5 py-1 rounded-full font-semibold hover:bg-amber-100 transition-colors flex items-center gap-1"
                        >
                            <Circle size={12} />
                            Mark In Process
                        </button>
                    ) : (
                        <div className="flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
                            <span className="text-[10px] text-slate-500">Sure?</span>
                            <button onClick={handleUnfinalise} className="text-[10px] bg-amber-600 text-white px-2 py-0.5 rounded font-semibold hover:bg-amber-700">Yes</button>
                            <button onClick={() => setConfirmUnfinalise(false)} className="text-[10px] bg-slate-200 text-slate-600 px-2 py-0.5 rounded font-semibold hover:bg-slate-300">No</button>
                        </div>
                    )
                )}
            </div>

            {expanded && (
                <div className="px-5 py-4 space-y-4">
                    {/* Mini Gantt for this project's milestones */}
                    {milestones.length > 0 && (
                        <div className="overflow-x-auto">
                            <div className="min-w-[700px]">
                                <div className="relative h-7">
                                    {months.map((m, i) => (
                                        <div key={i} className="absolute bottom-0 text-[10px] text-slate-400 font-medium" style={{ left: `${m.left}%`, transform: 'translateX(-50%)' }}>
                                            {m.label}
                                        </div>
                                    ))}
                                </div>
                                <div className="relative border-t border-slate-100 pt-1">
                                    {months.map((m, i) => (
                                        <div key={`vl-${i}`} className="absolute top-0 bottom-0 w-px bg-slate-50" style={{ left: `${m.left}%` }} />
                                    ))}
                                    <div className="absolute top-0 bottom-0 w-0.5 bg-red-400 z-10" style={{ left: `${nowPct}%` }} />

                                    {milestones.map((ms, idx) => {
                                        const msDate = ymdToLocalDate(ms.date);
                                        if (!msDate) return null;
                                        const pos = ((msDate.getTime() - timelineStart.getTime()) / totalMs) * 100;
                                        if (pos < -5 || pos > 105) return null;
                                        const clampedPos = Math.max(2, Math.min(pos, 98));

                                        return (
                                            <div key={idx} className="relative h-7 group">
                                                <div className="absolute left-0 text-[9px] font-medium text-slate-500 truncate w-[130px] top-1/2 -translate-y-1/2">
                                                    {ms.milestone}
                                                </div>
                                                <div
                                                    className="absolute top-1/2 h-px -translate-y-1/2 bg-slate-200"
                                                    style={{ left: '135px', width: `calc(${clampedPos}% - 135px)` }}
                                                />
                                                <div
                                                    className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 z-20"
                                                    style={{ left: `${clampedPos}%` }}
                                                >
                                                    {ms.completed ? (
                                                        <CheckCircle2 className="w-4 h-4 text-green-600 drop-shadow" />
                                                    ) : (
                                                        <Circle className="w-4 h-4 text-amber-500 drop-shadow" />
                                                    )}
                                                </div>
                                                <div
                                                    className="absolute text-[8px] font-bold whitespace-nowrap z-20"
                                                    style={{ left: `${clampedPos}%`, top: '100%', transform: 'translateX(-50%)' }}
                                                >
                                                    <span className={ms.completed ? 'text-green-600' : 'text-amber-600'}>
                                                        {formatUkDate(ms.date, { day: 'numeric', month: 'short' })}
                                                    </span>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Milestones Editor */}
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <h4 className="text-xs font-bold text-slate-600 uppercase tracking-wide flex items-center gap-2">Milestones & Tasks
                                <span role="status" className={`normal-case tracking-normal font-medium ${saveState.s === 'error' ? 'text-red-600' : 'text-slate-400'}`}>
                                    {saveState.s === 'saving' ? 'Saving…' : saveState.s === 'saved' ? 'Saved for everyone' : saveState.s === 'error' ? `Not saved: ${saveState.why}` : ''}
                                </span>
                                {saveState.s === 'error' && <button onClick={() => { pending.current = milestones; flush(); }} className="normal-case tracking-normal text-red-700 underline">Try again</button>}
                            </h4>
                            <div className="flex gap-2">
                                <button
                                    onClick={() => setShowPasteBox(!showPasteBox)}
                                    className="text-[10px] bg-purple-50 text-purple-700 border border-purple-200 px-2.5 py-1 rounded-full font-semibold hover:bg-purple-100 transition-colors flex items-center gap-1"
                                >
                                    <Sparkles size={11} />
                                    {milestones.length > 0 ? 'Regenerate with AI' : 'Generate with AI'}
                                </button>
                                <button
                                    onClick={addMilestone}
                                    className="text-[10px] bg-slate-50 text-slate-600 border border-slate-200 px-2.5 py-1 rounded-full font-semibold hover:bg-slate-100 transition-colors flex items-center gap-1"
                                >
                                    <Plus size={11} />
                                    Add Milestone
                                </button>
                            </div>
                        </div>

                        {/* AI Paste Box */}
                        {showPasteBox && (
                            <div className="p-3 bg-purple-50/50 border border-purple-200 rounded-lg space-y-2 animate-in fade-in">
                                <label className="text-[10px] font-bold text-purple-700 uppercase">Paste the full funding content / requirements</label>
                                <textarea
                                    className="w-full text-sm p-3 border border-purple-200 rounded-lg bg-white text-slate-700 min-h-[100px] resize-y focus:ring-2 focus:ring-purple-300 focus:outline-none"
                                    placeholder="Paste the grant award letter, terms & conditions, or requirements document here..."
                                    value={pasteContent}
                                    onChange={e => setPasteContent(e.target.value)}
                                />
                                <div className="flex gap-2">
                                    <button
                                        onClick={handleGenerateMilestones}
                                        disabled={aiLoading || !pasteContent.trim()}
                                        className="bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold px-4 py-2 rounded-lg flex items-center gap-2 disabled:opacity-50 transition-colors"
                                    >
                                        {aiLoading ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                                        {aiLoading ? 'Generating...' : 'Generate Milestones'}
                                    </button>
                                    <button
                                        onClick={() => setShowPasteBox(false)}
                                        className="text-xs text-slate-500 hover:text-slate-700 px-3"
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* Milestones List */}
                        {milestones.length === 0 && !showPasteBox && (
                            <div className="py-6 text-center text-slate-400 text-sm">
                                No milestones yet. Click "Generate with AI" or "Add Milestone" to get started.
                            </div>
                        )}

                        {milestones.map((ms, mIdx) => (
                            <div key={mIdx} className={`border rounded-lg overflow-hidden ${ms.completed ? 'bg-green-50/50 border-green-200' : 'bg-white border-slate-200'}`}>
                                <div className="flex items-center gap-2 px-3 py-2">
                                    <button
                                        onClick={() => toggleMilestoneComplete(mIdx)}
                                        className={`shrink-0 ${ms.completed ? 'text-green-600' : 'text-slate-300 hover:text-amber-500'}`}
                                        title={ms.completed ? 'Mark incomplete' : 'Mark complete'}
                                    >
                                        {ms.completed ? <CheckCircle2 size={18} /> : <Circle size={18} />}
                                    </button>
                                    <input
                                        className={`flex-1 text-sm font-semibold bg-transparent border-none outline-none ${ms.completed ? 'text-green-800 line-through' : 'text-slate-800'}`}
                                        value={ms.milestone}
                                        onChange={e => updateMilestoneName(mIdx, e.target.value)}
                                    />
                                    <input
                                        type="date"
                                        className="text-xs border border-slate-200 rounded px-2 py-1 text-slate-600 bg-white"
                                        value={ms.date}
                                        onChange={e => updateMilestoneDate(mIdx, e.target.value)}
                                    />
                                    <button onClick={() => { if (confirm(`Delete the milestone "${ms.milestone}"?`)) removeMilestone(mIdx); }} className="p-1 hover:bg-red-50 rounded text-slate-300 hover:text-red-500 transition-colors">
                                        <Trash2 size={14} />
                                    </button>
                                </div>
                                {/* Tasks */}
                                <div className="px-3 pb-2 pl-10 space-y-1">
                                    {ms.tasks.map((task, tIdx) => (
                                        <div key={tIdx} className="flex items-center gap-1.5 group/task">
                                            <span className="text-slate-300 text-[10px]">•</span>
                                            <input
                                                className={`flex-1 text-xs bg-transparent border-none outline-none ${ms.completed ? 'text-green-700/60 line-through' : 'text-slate-600'}`}
                                                value={task}
                                                onChange={e => updateTask(mIdx, tIdx, e.target.value)}
                                            />
                                            <button
                                                onClick={() => removeTask(mIdx, tIdx)}
                                                className="opacity-0 group-hover/task:opacity-100 p-0.5 hover:bg-red-50 rounded text-slate-300 hover:text-red-500 transition-all"
                                            >
                                                <Trash2 size={10} />
                                            </button>
                                        </div>
                                    ))}
                                    <button
                                        onClick={() => addTask(mIdx)}
                                        className="text-[10px] text-purple-500 hover:text-purple-700 font-medium flex items-center gap-0.5 mt-1"
                                    >
                                        <Plus size={10} /> Add task
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

export function GrantedProjectsChart({ grants, onStatusChange, isFinalisedView = false }: GrantedProjectsChartProps) {
    const displayGrants = useMemo(() => {
        return grants.filter(g =>
            g.status === 'Granted' &&
            (isFinalisedView ? g.grantProgress === 'Finalised' : g.grantProgress !== 'Finalised')
        );
    }, [grants, isFinalisedView]);

    if (displayGrants.length === 0) {
        return (
            <div className="bg-white rounded-lg border shadow-sm p-12 text-center">
                {isFinalisedView ? <CheckCircle2 className="h-10 w-10 text-slate-300 mx-auto mb-3" /> : <Award className="h-10 w-10 text-slate-300 mx-auto mb-3" />}
                <p className="text-slate-500 text-sm">No {isFinalisedView ? 'finalised' : 'granted'} projects to manage yet.</p>
                <p className="text-slate-400 text-xs mt-1">When a grant is tagged as {isFinalisedView ? 'Finalised' : 'Granted'}, it will appear here automatically.</p>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <div className="flex items-center gap-2 text-xs text-slate-500 px-1">
                {isFinalisedView ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Award className="h-4 w-4 text-green-600" />}
                <span className="font-semibold text-slate-700">{displayGrants.length} {isFinalisedView ? 'finalised' : 'active'} project{displayGrants.length !== 1 ? 's' : ''}</span>
                <span>Paste the funding details to generate milestones, or add them by hand. Milestones are saved on the grant for everyone.</span>
            </div>
            {displayGrants.map(g => (
                <GrantProjectCard key={g.id} grant={g} onStatusChange={async (id, status) => {
                    // Make sure grant progress changes are tracked here properly instead of just 'status'
                    // We actually need to update grantProgress, not just status
                    try {
                        const { getFirestore, doc, updateDoc } = await import('firebase/firestore');
                        const { db } = await import('@/lib/firebase');
                        const grantRef = doc(db, 'grants', id);
                        await updateDoc(grantRef, { grantProgress: status });

                        // Let parent know of update by just calling function without changing status
                        await onStatusChange(id, 'Granted');
                    } catch (err) {
                        console.error('Failed to update progress', err);
                    }
                }} />
            ))}
        </div>
    );
}
