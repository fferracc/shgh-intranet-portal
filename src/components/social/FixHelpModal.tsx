"use client";

import React from "react";
import { Wrench, X, Pencil, AlertTriangle } from "lucide-react";
import type { FixHelp } from "@/lib/social/mediaCheck";

// 6 Oct 2026: the pop-up that says what went wrong with a post and, step by step, how to put
// it back to work. Sits above the other social windows (z-60), so it can open over the
// compose or approve window too.
export default function FixHelpModal({
    help,
    postLabel,
    onClose,
    onEdit,
}: {
    help: FixHelp;
    postLabel?: string;
    onClose: () => void;
    onEdit?: () => void;
}) {
    return (
        <div
            className="fixed inset-0 bg-black/50 z-[60] flex items-start justify-center overflow-y-auto py-10 px-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="fix-help-title"
        >
            <div className="bg-white rounded-xl w-full max-w-lg p-6 shadow-xl">
                <div className="flex items-start justify-between gap-3 mb-4">
                    <div className="flex items-start gap-3">
                        <div className="w-9 h-9 rounded-full bg-red-100 text-red-700 flex items-center justify-center flex-shrink-0">
                            <Wrench size={18} />
                        </div>
                        <div>
                            <h2 id="fix-help-title" className="text-lg font-bold text-slate-800 leading-snug">{help.title}</h2>
                            {postLabel && <p className="text-xs text-slate-500 mt-0.5">{postLabel}</p>}
                        </div>
                    </div>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-700" aria-label="Close">
                        <X size={20} />
                    </button>
                </div>

                <p className="text-sm text-slate-700 mb-4">{help.what}</p>

                <p className="text-sm font-medium text-slate-800 mb-2">How to put it back to work</p>
                <ol className="list-decimal pl-5 space-y-1.5 text-sm text-slate-700 mb-4">
                    {help.steps.map((s, i) => (
                        <li key={i}>{s}</li>
                    ))}
                </ol>

                {!help.canFixHere && (
                    <p className="mb-4 text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex items-start gap-2">
                        <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
                        The first step needs Franco. Nothing in the post has to change.
                    </p>
                )}

                <div className="flex justify-end gap-2">
                    {onEdit && help.canFixHere && (
                        <button
                            onClick={onEdit}
                            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
                        >
                            <Pencil size={14} />
                            Edit the post
                        </button>
                    )}
                    <button
                        onClick={onClose}
                        className="px-4 py-2 text-sm font-medium text-white bg-slate-800 rounded-lg hover:bg-slate-900"
                    >
                        Got it
                    </button>
                </div>
            </div>
        </div>
    );
}
