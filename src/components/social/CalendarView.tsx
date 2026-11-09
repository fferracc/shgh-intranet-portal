"use client";

import React, { useEffect, useMemo, useState } from "react";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { SocialPost, SocialPostStatus, SocialNetwork, SocialStrategy } from "@/lib/types";
import { isoToLondon, londonToIso } from "@/lib/social/londonTime";
import { CONNECTED_NETWORKS_NOTE, isConnected, NOT_CONNECTED_BADGE } from "@/lib/social/networks";
import {
    Facebook,
    Instagram,
    Linkedin,
    Youtube,
    AtSign,
    Music2,
    ChevronLeft,
    ChevronRight,
    CalendarClock,
    Lightbulb,
    Check,
} from "lucide-react";

const NETWORK_ICON: Record<SocialNetwork, any> = {
    facebook: Facebook,
    instagram: Instagram,
    threads: AtSign,
    linkedin: Linkedin,
    youtube: Youtube,
    tiktok: Music2,
};

// Colour carries state at a glance: green went out, blue is waiting to go,
// amber needs a human, red broke, grey is done with.
const STATUS_CHIP: Record<SocialPostStatus, string> = {
    draft: "bg-slate-100 text-slate-700 border-slate-300",
    approved: "bg-blue-100 text-blue-900 border-blue-300",
    published: "bg-green-100 text-green-900 border-green-300",
    rejected: "bg-slate-100 text-slate-500 border-slate-200",
    refused: "bg-amber-100 text-amber-900 border-amber-300",
    blockedSafeguarding: "bg-amber-100 text-amber-900 border-amber-400",
    failed: "bg-red-100 text-red-900 border-red-300",
    removed: "bg-slate-100 text-slate-400 border-slate-200",
};

// Published and removed posts are history — dragging them would imply you
// could un-send something.
// Failed, blocked and refused posts go back to draft first (the database only lets drafts and
// approved posts be rescheduled), so they open for editing instead of being dragged.
const MOVABLE: SocialPostStatus[] = ["draft", "approved"];
const IN_TRAY: SocialPostStatus[] = ["draft", "approved", "refused", "blockedSafeguarding", "failed"];

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function startOfMonthGrid(view: Date) {
    const first = new Date(view.getFullYear(), view.getMonth(), 1);
    // Monday-first week, matching UK convention.
    const shift = (first.getDay() + 6) % 7;
    return new Date(first.getFullYear(), first.getMonth(), 1 - shift);
}

function sameDay(a: Date, b: Date) {
    return (
        a.getFullYear() === b.getFullYear() &&
        a.getMonth() === b.getMonth() &&
        a.getDate() === b.getDate()
    );
}

function dayKey(d: Date) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// The UK day a post sits on (1 Oct 2026): its time read in Europe/London, so a post at
// 00:30 BST is on the right day whatever zone the computer is set to.
function londonKeyOf(post: SocialPost): { key: string; time: string } | null {
    // Only scheduled or published posts have a place on a calendar. Anything
    // else lives in the unscheduled tray until someone gives it a date.
    const raw = post.publishedAt || post.scheduledFor;
    if (!raw) return null;
    const t = isoToLondon(String(raw));
    return t.date ? { key: t.date, time: t.time } : null;
}
const dateKeyOf = (post: SocialPost) => londonKeyOf(post);

// A post only counts towards the week's cadence if it is still alive. Rejected
// and removed posts should not make a week look full.
const COUNTS_TOWARDS_CADENCE: SocialPostStatus[] = [
    "draft",
    "approved",
    "published",
    "refused",
    "blockedSafeguarding",
    "failed",
];

interface Suggestion {
    network: SocialNetwork;
    theme: string;
    anchor?: string;
}

export default function CalendarView({
    posts,
    onChanged,
    onOpen,
}: {
    posts: SocialPost[];
    onChanged: () => void;
    onOpen: (post: SocialPost) => void;
}) {
    const today = new Date();
    const [view, setView] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
    const [dragId, setDragId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const gridStart = startOfMonthGrid(view);
    const cells: Date[] = Array.from({ length: 42 }, (_, i) => {
        const d = new Date(gridStart);
        d.setDate(gridStart.getDate() + i);
        return d;
    });
    // Six rows is always enough; five is usually enough. Trim the trailing
    // empty week so the grid doesn't look padded.
    const weeks = cells.some((d, i) => i >= 35 && d.getMonth() === view.getMonth()) ? 6 : 5;
    const visibleCells = cells.slice(0, weeks * 7);

    const unscheduled = posts.filter(
        (p) => !dateKeyOf(p) && IN_TRAY.includes(p.status)
    );

    // --- Suggestions -------------------------------------------------------
    //
    // These are prompts for a human, never drafts and never scheduled. They
    // read the annual plan and show where the month is falling short of the
    // cadence it says is realistic. If no plan is saved, nothing appears.

    const [plan, setPlan] = useState<SocialStrategy | null>(null);
    const [showIdeas, setShowIdeas] = useState(true);
    const [copied, setCopied] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        const loadPlan = async () => {
            try {
                const snap = await getDoc(doc(db, "socialStrategy", String(view.getFullYear())));
                if (cancelled) return;
                setPlan(snap.exists() ? ({ id: snap.id, ...(snap.data() as any) } as SocialStrategy) : null);
            } catch {
                // A missing or unreadable plan is not an error worth showing on
                // a calendar. The month is still perfectly usable without it.
                if (!cancelled) setPlan(null);
            }
        };
        loadPlan();
        return () => {
            cancelled = true;
        };
    }, [view]);

    const suggestions = useMemo(() => {
        const out: Record<string, Suggestion[]> = {};
        if (!plan || !showIdeas) return out;

        const cadence = plan.cadence || {};
        const themes = (plan.themes || []).filter((t) => t && t.name);
        if (!themes.length) return out;

        const midnightToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        let rotation = 0;

        for (let w = 0; w < visibleCells.length / 7; w++) {
            const week = visibleCells.slice(w * 7, w * 7 + 7);

            (Object.keys(cadence) as SocialNetwork[]).forEach((network, networkIndex) => {
                const target = Number(cadence[network]) || 0;
                if (target <= 0) return;

                const already = posts.filter((p) => {
                    if (p.network !== network) return false;
                    if (!COUNTS_TOWARDS_CADENCE.includes(p.status)) return false;
                    const d = dateKeyOf(p);
                    return !!d && week.some((wd) => dayKey(wd) === d.key);
                }).length;

                let deficit = target - already;
                if (deficit <= 0) return;

                // Only days that are in the month being viewed, not in the past,
                // and not already carrying two ideas.
                for (const day of week) {
                    if (deficit <= 0) break;
                    if (day.getMonth() !== view.getMonth()) continue;
                    if (day < midnightToday) continue;

                    const key = dayKey(day);
                    const existing = out[key] || [];
                    if (existing.length >= 2) continue;
                    if (existing.some((s) => s.network === network)) continue;

                    const eligible = themes.filter(
                        (t) => !t.networks || !t.networks.length || t.networks.includes(network)
                    );
                    const pool = eligible.length ? eligible : themes;
                    const theme = pool[(rotation + networkIndex + w) % pool.length];
                    rotation++;

                    const anchor = (plan.anchors || []).find(
                        (a) => a && a.date && key.startsWith(String(a.date).slice(0, 7))
                    );

                    out[key] = [...existing, { network, theme: theme.name, anchor: anchor?.label }];
                    deficit--;
                }
            });
        }

        return out;
    }, [plan, showIdeas, posts, visibleCells, view, today]);

    const copySuggestion = async (s: Suggestion) => {
        const text = s.anchor ? `${s.theme}: ${s.anchor}` : s.theme;
        try {
            await navigator.clipboard.writeText(text);
            setCopied(text);
            window.setTimeout(() => setCopied(null), 1800);
        } catch {
            // Clipboard permission is not worth an error message here.
        }
    };

    const reschedule = async (postId: string, day: Date) => {
        setError(null);
        const post = posts.find((p) => p.id === postId);
        if (!post) return;

        // Keep the UK time of day if it had one, so dragging a 9am post to Friday
        // keeps it at 9am rather than resetting to midnight (and never moves it an hour in summer).
        const existing = dateKeyOf(post);
        const nextIso = londonToIso(dayKey(day), existing ? existing.time : "10:00");
        if (!nextIso) return;

        try {
            await updateDoc(doc(db, "socialPosts", postId), {
                scheduledFor: nextIso,
                updatedAt: new Date().toISOString(),
            });
            onChanged();
        } catch (err: any) {
            setError(err?.message ?? "Could not move that post.");
        }
    };

    const monthLabel = view.toLocaleDateString("en-GB", { month: "long", year: "numeric" });

    return (
        <div>
            <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
                <h2 className="text-lg font-medium text-slate-800">{monthLabel}</h2>
                <div className="flex gap-2">
                    <button
                        onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))}
                        className="p-2 text-slate-600 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
                        aria-label="Previous month"
                    >
                        <ChevronLeft size={16} />
                    </button>
                    <button
                        onClick={() => setView(new Date(today.getFullYear(), today.getMonth(), 1))}
                        className="px-3 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
                    >
                        Today
                    </button>
                    {plan && (
                        <button
                            onClick={() => setShowIdeas((v) => !v)}
                            title="Greyed ideas drawn from the content plan, where the week is short of its cadence"
                            className={
                                "px-3 py-2 text-sm font-medium rounded-lg border inline-flex items-center gap-1.5 " +
                                (showIdeas
                                    ? "text-amber-900 bg-amber-50 border-amber-300 hover:bg-amber-100"
                                    : "text-slate-600 bg-white border-slate-300 hover:bg-slate-50")
                            }
                        >
                            <Lightbulb size={15} />
                            Ideas
                        </button>
                    )}
                    <button
                        onClick={() => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))}
                        className="p-2 text-slate-600 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
                        aria-label="Next month"
                    >
                        <ChevronRight size={16} />
                    </button>
                </div>
            </div>

            {error && (
                <p className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                    {error}
                </p>
            )}

            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50">
                    {DAY_LABELS.map((d) => (
                        <div key={d} className="px-2 py-2 text-xs font-medium text-slate-500 text-center">
                            {d}
                        </div>
                    ))}
                </div>

                <div className="grid grid-cols-7">
                    {visibleCells.map((day, i) => {
                        const inMonth = day.getMonth() === view.getMonth();
                        const isToday = sameDay(day, today);
                        const dayPosts = posts.filter((p) => {
                            const d = dateKeyOf(p);
                            return d && d.key === dayKey(day);
                        });

                        return (
                            <div
                                key={i}
                                onDragOver={(e) => {
                                    if (dragId) e.preventDefault();
                                }}
                                onDrop={(e) => {
                                    e.preventDefault();
                                    if (dragId) {
                                        reschedule(dragId, day);
                                        setDragId(null);
                                    }
                                }}
                                className={
                                    "min-h-[104px] border-b border-r border-slate-100 p-1.5 " +
                                    (inMonth ? "bg-white" : "bg-slate-50/60") +
                                    (dragId ? " hover:bg-blue-50" : "")
                                }
                            >
                                <div
                                    className={
                                        "text-xs mb-1 px-1 " +
                                        (isToday
                                            ? "font-bold text-blue-700"
                                            : inMonth
                                                ? "text-slate-500"
                                                : "text-slate-300")
                                    }
                                >
                                    {day.getDate()}
                                </div>

                                <div className="space-y-1">
                                    {dayPosts.map((p) => {
                                        const Icon = NETWORK_ICON[p.network] ?? AtSign;
                                        const movable = MOVABLE.includes(p.status);
                                        return (
                                            <div
                                                key={p.id}
                                                draggable={movable}
                                                onDragStart={() => movable && setDragId(p.id)}
                                                onDragEnd={() => setDragId(null)}
                                                onClick={() => onOpen(p)}
                                                title={`${isConnected(p.network) ? "" : `${NOT_CONNECTED_BADGE}. `}${p.copy}`}
                                                className={
                                                    "text-[11px] leading-tight px-1.5 py-1 rounded border truncate " +
                                                    STATUS_CHIP[p.status] +
                                                    (movable ? " cursor-grab" : " cursor-pointer")
                                                }
                                            >
                                                <span className="inline-flex items-center gap-1">
                                                    <Icon size={10} />
                                                    <span className="truncate">{p.copy.slice(0, 40)}</span>
                                                </span>
                                            </div>
                                        );
                                    })}

                                    {(suggestions[dayKey(day)] || []).map((s, si) => {
                                        const Icon = NETWORK_ICON[s.network] ?? AtSign;
                                        return (
                                            <div
                                                key={"sug" + si}
                                                onClick={() => copySuggestion(s)}
                                                title={`Idea from the content plan${s.anchor ? ` (${s.anchor})` : ""}. Click to copy, then press New post or Write with AI. Nothing is scheduled.`}
                                                className="text-[11px] leading-tight px-1.5 py-1 rounded border border-dashed border-slate-300 text-slate-400 bg-white cursor-copy truncate hover:border-amber-400 hover:text-amber-700"
                                            >
                                                <span className="inline-flex items-center gap-1">
                                                    <Icon size={10} />
                                                    <span className="truncate">{s.theme}</span>
                                                </span>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {unscheduled.length > 0 && (
                <div className="mt-5">
                    <h3 className="text-sm font-medium text-slate-700 mb-2 flex items-center gap-2">
                        <CalendarClock size={15} />
                        No date yet ({unscheduled.length})
                    </h3>
                    <p className="text-xs text-slate-500 mb-2">
                        Drag any of these onto a day to schedule it. Approved posts with no date go out at the next run.
                    </p>
                    <div className="flex flex-wrap gap-2">
                        {unscheduled.map((p) => {
                            const Icon = NETWORK_ICON[p.network] ?? AtSign;
                            const movable = MOVABLE.includes(p.status);
                            return (
                                <div
                                    key={p.id}
                                    draggable={movable}
                                    onDragStart={() => movable && setDragId(p.id)}
                                    onDragEnd={() => setDragId(null)}
                                    onClick={() => onOpen(p)}
                                    title={p.copy}
                                    className={
                                        "text-xs px-2 py-1.5 rounded border max-w-[260px] truncate " + (movable ? "cursor-grab " : "cursor-pointer ") +
                                        STATUS_CHIP[p.status]
                                    }
                                >
                                    <span className="inline-flex items-center gap-1.5">
                                        <Icon size={11} />
                                        <span className="truncate">{p.copy.slice(0, 50)}</span>
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {copied && (
                <p className="mt-4 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 inline-flex items-center gap-1.5">
                    <Check size={13} />
                    Copied “{copied}”. Press New post or Write with AI to use it.
                </p>
            )}

            {plan && showIdeas && (
                <p className="mt-4 text-xs text-slate-500 flex items-start gap-1.5 max-w-2xl">
                    <Lightbulb size={13} className="mt-0.5 flex-shrink-0" />
                    <span>
                        Dashed cards are ideas from the content plan, shown where a week is
                        short of the cadence you set. They are prompts, not drafts: nothing
                        is written or scheduled until you create a post yourself.
                    </span>
                </p>
            )}

            <p className="mt-4 text-xs text-slate-500 max-w-2xl">Click a post to open it: drafts, approved and scheduled posts open for editing, published ones show their details. {CONNECTED_NETWORKS_NOTE}</p>

            <div className="mt-5 flex flex-wrap gap-3 text-xs text-slate-500">
                {(["draft", "approved", "published", "failed", "blockedSafeguarding"] as SocialPostStatus[]).map((s) => (
                    <span key={s} className="inline-flex items-center gap-1.5">
                        <span className={"inline-block w-3 h-3 rounded border " + STATUS_CHIP[s]} />
                        {s === "blockedSafeguarding" ? "blocked" : s}
                    </span>
                ))}
            </div>
        </div>
    );
}
