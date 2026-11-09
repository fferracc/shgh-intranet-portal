"use client";

import DashboardLayout from "@/components/layout/DashboardLayout";
import React, { useEffect, useState } from "react";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/contexts/AuthContext";
import { SocialNetwork, SocialStrategy, StrategyAnchor, StrategyAudience, StrategyTheme } from "@/lib/types";
import {
    Target,
    Plus,
    Trash2,
    Save,
    ArrowUp,
    ArrowDown,
    ShieldAlert,
    Info,
    CheckCircle2,
    AlertTriangle,
} from "lucide-react";
import { can } from "@/lib/permissions";
import { CONNECTED_NETWORKS_NOTE, NOT_CONNECTED_BADGE, SOCIAL_NETWORKS } from "@/lib/social/networks";

const NETWORKS: { key: SocialNetwork; label: string; connected: boolean }[] = SOCIAL_NETWORKS.map(n => ({ key: n.key, label: n.label, connected: n.connected }));

// Quarters are calendar quarters, the same ones the socialDrafts function uses (1 Oct 2026).
const QUARTER_LABEL: Record<"q1" | "q2" | "q3" | "q4", string> = {
    q1: "Q1 (January to March)",
    q2: "Q2 (April to June)",
    q3: "Q3 (July to September)",
    q4: "Q4 (October to December)",
};

const ANCHOR_TYPES = ["season", "deadline", "awareness", "term", "other"] as const;

// A starting shape, not content to publish. Everything here comes from the
// studio spec Franco wrote — the seasonal rhythm and the exclusions — so it is
// his material to correct, not invented facts. Nothing is saved until he
// presses Save.
function seedPlan(year: number): Omit<SocialStrategy, "id"> {
    return {
        year,
        purpose: "",
        audiences: [
            { name: "Prospective learners and their families", notes: "" },
            { name: "Referrers — social workers, community organisations, job centres", notes: "" },
            { name: "Funders and grant assessors", notes: "" },
            { name: "Volunteers", notes: "" },
            { name: "Donors", notes: "" },
        ],
        successMeasures: [
            "Enrolments that came from social",
            "Referral form completions",
            "Volunteer enquiries",
        ],
        neverPost: [
            "Identifiable children without recorded photo consent",
            "Anything implying a learner's personal circumstances",
            "Political content",
        ],
        themes: [
            { name: "Recruitment — courses, enrolment, referrals", sharePercent: 30, networks: ["facebook", "instagram"] },
            { name: "Impact and learner stories", sharePercent: 25, networks: ["instagram", "linkedin"] },
            { name: "Educational — digital skills, online safety", sharePercent: 20, networks: ["instagram", "threads"] },
            { name: "Funders, partners, awards", sharePercent: 15, networks: ["linkedin"] },
            { name: "Volunteering and appeals", sharePercent: 10, networks: ["facebook", "linkedin"] },
        ],
        cadence: { facebook: 2, instagram: 2, threads: 2, linkedin: 1 },
        anchors: [
            { date: `${year}-09`, label: "New academic year — cohort intakes, biggest recruitment push", type: "season", notes: "" },
            { date: `${year}-11`, label: "Grant reporting season", type: "deadline", notes: "" },
            { date: `${year}-12`, label: "Christmas appeal — Ghana children's home", type: "season", notes: "" },
            { date: `${year + 1}-01`, label: "New year intake, digital inclusion angle", type: "season", notes: "" },
            { date: `${year + 1}-06`, label: "Refugee Week and Volunteers Week", type: "awareness", notes: "" },
            { date: `${year + 1}-07`, label: "Robotics workshops, intensive courses", type: "season", notes: "" },
        ],
        quarterFocus: { q1: "", q2: "", q3: "", q4: "" },
    };
}

function Section({
    title,
    hint,
    children,
}: {
    title: string;
    hint?: string;
    children: React.ReactNode;
}) {
    return (
        <section className="bg-white border border-slate-200 rounded-xl p-5 mb-5">
            <h2 className="text-base font-semibold text-slate-800">{title}</h2>
            {hint && <p className="text-sm text-slate-500 mt-1 mb-4">{hint}</p>}
            <div className={hint ? "" : "mt-4"}>{children}</div>
        </section>
    );
}

export default function SocialPlanPage() {
    const { user } = useAuth();
    const canView = can(user, 'social_media');

    const thisYear = new Date().getFullYear();
    const [year, setYear] = useState(thisYear);
    const [plan, setPlan] = useState<Omit<SocialStrategy, "id"> | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    const [isNew, setIsNew] = useState(false);
    // What was last loaded or saved, to tell whether there are unsaved changes (1 Oct 2026).
    const [baseline, setBaseline] = useState("");
    const dirty = !!plan && baseline !== "" && JSON.stringify(plan) !== baseline;

    useEffect(() => {
        const warn = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [dirty]);

    const switchYear = (next: number) => {
        if (next === year) return;
        if (dirty && !confirm(`You have changes to the ${year} plan that are not saved.\n\nSwitch to ${next} and lose them?`)) return;
        setBaseline("");
        setYear(next);
    };

    useEffect(() => {
        if (!canView) return;
        let cancelled = false;

        const load = async () => {
            setLoading(true);
            setError(null);
            setSaved(false);
            try {
                const snap = await getDoc(doc(db, "socialStrategy", String(year)));
                if (cancelled) return;
                if (snap.exists()) {
                    const data = snap.data() as any;
                    const loaded = { ...seedPlan(year), ...data, year };
                    setPlan(loaded);
                    setBaseline(JSON.stringify(loaded));
                    setIsNew(false);
                } else {
                    const seeded = seedPlan(year);
                    setPlan(seeded);
                    setBaseline(JSON.stringify(seeded));
                    setIsNew(true);
                }
            } catch (err: any) {
                if (!cancelled) setError(err?.message ?? "Could not load the plan.");
            } finally {
                if (!cancelled) setLoading(false);
            }
        };

        load();
        return () => {
            cancelled = true;
        };
    }, [year, canView]);

    const patch = (changes: Partial<Omit<SocialStrategy, "id">>) => {
        setPlan((p) => (p ? { ...p, ...changes } : p));
        setSaved(false);
    };

    const save = async () => {
        if (!plan || !user) return;
        setSaving(true);
        setError(null);
        try {
            const record = {
                ...plan,
                year,
                // The rules require this to equal the caller, same principle as
                // approving a post: the record of who changed the plan cannot be
                // set to someone else.
                updatedByUid: user.uid,
                updatedByName: user.displayName || user.email,
                updatedAt: new Date().toISOString(),
            };
            await setDoc(doc(db, "socialStrategy", String(year)), record);
            setPlan(record as any);
            setBaseline(JSON.stringify(record));
            setIsNew(false);
            setSaved(true);
        } catch (err: any) {
            setError(err?.message ?? "Could not save.");
        } finally {
            setSaving(false);
        }
    };

    if (user && !canView) {
        return (
            <DashboardLayout>
                <div className="max-w-2xl">
                    <h1 className="text-2xl font-bold text-slate-800 mb-2">Content Plan</h1>
                    <p className="text-slate-600">This section is restricted to administrators.</p>
                </div>
            </DashboardLayout>
        );
    }

    const themeTotal = plan ? plan.themes.reduce((sum, t) => sum + (Number(t.sharePercent) || 0), 0) : 0;
    const weeklyTotal = plan
        ? Object.values(plan.cadence || {}).reduce((sum: number, n) => sum + (Number(n) || 0), 0)
        : 0;

    // --- list helpers -------------------------------------------------------

    const moveAudience = (i: number, delta: number) => {
        if (!plan) return;
        const next = [...plan.audiences];
        const j = i + delta;
        if (j < 0 || j >= next.length) return;
        [next[i], next[j]] = [next[j], next[i]];
        patch({ audiences: next });
    };

    const setAudience = (i: number, changes: Partial<StrategyAudience>) => {
        if (!plan) return;
        const next = [...plan.audiences];
        next[i] = { ...next[i], ...changes };
        patch({ audiences: next });
    };

    const setTheme = (i: number, changes: Partial<StrategyTheme>) => {
        if (!plan) return;
        const next = [...plan.themes];
        next[i] = { ...next[i], ...changes };
        patch({ themes: next });
    };

    const setAnchor = (i: number, changes: Partial<StrategyAnchor>) => {
        if (!plan) return;
        const next = [...plan.anchors];
        next[i] = { ...next[i], ...changes };
        patch({ anchors: next });
    };

    const setStringList = (key: "successMeasures" | "neverPost", i: number, value: string) => {
        if (!plan) return;
        const next = [...plan[key]];
        next[i] = value;
        patch({ [key]: next } as any);
    };

    return (
        <DashboardLayout>
            <div className="max-w-4xl">
                <div className="flex items-start justify-between gap-4 mb-6">
                    <div>
                        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
                            <Target size={22} className="text-slate-500" />
                            Content Plan
                        </h1>
                        <p className="text-slate-600 mt-1">
                            What we are trying to achieve by posting at all. Every draft the studio
                            writes reads this first.
                        </p>
                    </div>

                    <div className="flex items-center gap-2">
                        {dirty && <span className="text-xs font-medium text-amber-700" role="status">Changes not saved yet</span>}
                        <select
                            value={year}
                            onChange={(e) => switchYear(Number(e.target.value))}
                            aria-label="Plan year"
                            className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                        >
                            {[thisYear - 1, thisYear, thisYear + 1].map((y) => (
                                <option key={y} value={y}>
                                    {y}
                                </option>
                            ))}
                        </select>
                        <button
                            onClick={save}
                            disabled={saving || loading || !plan}
                            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-slate-800 rounded-lg hover:bg-slate-900 disabled:opacity-50"
                        >
                            <Save size={16} />
                            {saving ? "Saving…" : "Save plan"}
                        </button>
                    </div>
                </div>

                {error && (
                    <div className="mb-5 p-4 bg-red-50 border border-red-300 rounded-xl flex items-start gap-3">
                        <AlertTriangle size={20} className="text-red-700 flex-shrink-0 mt-0.5" />
                        <p className="text-sm text-red-800">{error}</p>
                    </div>
                )}

                {saved && (
                    <div className="mb-5 p-4 bg-green-50 border border-green-300 rounded-xl flex items-start gap-3">
                        <CheckCircle2 size={20} className="text-green-700 flex-shrink-0 mt-0.5" />
                        <p className="text-sm text-green-800">
                            Saved. New drafts will use this from now on.
                        </p>
                    </div>
                )}

                {isNew && !loading && (
                    <div className="mb-5 p-4 bg-blue-50 border border-blue-200 rounded-xl flex items-start gap-3">
                        <Info size={20} className="text-blue-700 flex-shrink-0 mt-0.5" />
                        <div className="text-sm text-blue-900">
                            <p className="font-medium">Nothing saved for {year} yet.</p>
                            <p className="mt-0.5">
                                What is on screen is a starting shape drawn from the studio spec, not
                                a saved plan. Correct it and press Save. Until you do, drafting
                                carries on without a plan for {year}.
                            </p>
                        </div>
                    </div>
                )}

                {loading && <p className="text-slate-500">Loading…</p>}

                {plan && !loading && (
                    <>
                        <Section
                            title="Why we post at all"
                            hint="One honest paragraph. This is the line every draft is written against, so vagueness here shows up in every post."
                        >
                            <textarea
                                value={plan.purpose}
                                onChange={(e) => patch({ purpose: e.target.value })}
                                rows={4}
                                placeholder="Reach learners who don't know we exist. Reassure funders that the work is real. Recruit volunteers. Show the Ghana work to UK donors."
                                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                            />
                        </Section>

                        <Section
                            title="Audiences, in order"
                            hint="The order is the ranking and it is load-bearing. Funders first produces markedly different copy from learners first."
                        >
                            {plan.audiences.map((a, i) => (
                                <div key={i} className="flex items-start gap-2 mb-2">
                                    <span className="mt-2 w-5 text-sm text-slate-400 text-right">{i + 1}</span>
                                    <div className="flex-1 space-y-1">
                                        <input
                                            value={a.name}
                                            onChange={(e) => setAudience(i, { name: e.target.value })}
                                            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                                        />
                                        <input
                                            value={a.notes ?? ""}
                                            onChange={(e) => setAudience(i, { notes: e.target.value })}
                                            placeholder="What they need to hear (optional)"
                                            className="w-full px-3 py-1.5 text-xs border border-slate-200 rounded-lg text-slate-600"
                                        />
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <button onClick={() => moveAudience(i, -1)} className="p-1 text-slate-400 hover:text-slate-700" aria-label="Move up">
                                            <ArrowUp size={14} />
                                        </button>
                                        <button onClick={() => moveAudience(i, 1)} className="p-1 text-slate-400 hover:text-slate-700" aria-label="Move down">
                                            <ArrowDown size={14} />
                                        </button>
                                    </div>
                                    <button
                                        onClick={() => patch({ audiences: plan.audiences.filter((_, k) => k !== i) })}
                                        className="p-1 mt-1 text-slate-400 hover:text-red-600"
                                        aria-label="Remove"
                                    >
                                        <Trash2 size={14} />
                                    </button>
                                </div>
                            ))}
                            <button
                                onClick={() => patch({ audiences: [...plan.audiences, { name: "", notes: "" }] })}
                                className="mt-2 flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900"
                            >
                                <Plus size={14} /> Add an audience
                            </button>
                        </Section>

                        <Section
                            title="What success looks like"
                            hint="Things that actually matter to the charity. Follower count is not one of them."
                        >
                            {plan.successMeasures.map((m, i) => (
                                <div key={i} className="flex items-center gap-2 mb-2">
                                    <input
                                        value={m}
                                        onChange={(e) => setStringList("successMeasures", i, e.target.value)}
                                        className="flex-1 px-3 py-2 text-sm border border-slate-300 rounded-lg"
                                    />
                                    <button
                                        onClick={() => patch({ successMeasures: plan.successMeasures.filter((_, k) => k !== i) })}
                                        className="p-1 text-slate-400 hover:text-red-600"
                                        aria-label="Remove"
                                    >
                                        <Trash2 size={14} />
                                    </button>
                                </div>
                            ))}
                            <button
                                onClick={() => patch({ successMeasures: [...plan.successMeasures, ""] })}
                                className="mt-1 flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900"
                            >
                                <Plus size={14} /> Add a measure
                            </button>
                        </Section>

                        <section className="bg-amber-50 border border-amber-300 rounded-xl p-5 mb-5">
                            <h2 className="text-base font-semibold text-amber-900 flex items-center gap-2">
                                <ShieldAlert size={18} />
                                Things we never post
                            </h2>
                            <p className="text-sm text-amber-800 mt-1 mb-4">
                                These go into the drafting prompt as hard constraints, so this is the
                                one place the safeguarding rules reach the writing stage rather than
                                only the publishing gate. The gates in n8n and the Firestore rules
                                still apply on top: this does not replace them.
                            </p>
                            {plan.neverPost.map((n, i) => (
                                <div key={i} className="flex items-center gap-2 mb-2">
                                    <input
                                        value={n}
                                        onChange={(e) => setStringList("neverPost", i, e.target.value)}
                                        className="flex-1 px-3 py-2 text-sm border border-amber-300 rounded-lg bg-white"
                                    />
                                    <button
                                        onClick={() => patch({ neverPost: plan.neverPost.filter((_, k) => k !== i) })}
                                        className="p-1 text-amber-700 hover:text-red-700"
                                        aria-label="Remove"
                                    >
                                        <Trash2 size={14} />
                                    </button>
                                </div>
                            ))}
                            <button
                                onClick={() => patch({ neverPost: [...plan.neverPost, ""] })}
                                className="mt-1 flex items-center gap-1.5 text-sm text-amber-900 hover:text-amber-950"
                            >
                                <Plus size={14} /> Add an exclusion
                            </button>
                        </section>

                        <Section
                            title="Themes and mix"
                            hint="Proportions are a steering wheel, not a quota. If a real story arrives, it wins."
                        >
                            {plan.themes.map((t, i) => (
                                <div key={i} className="border border-slate-200 rounded-lg p-3 mb-3">
                                    <div className="flex items-center gap-2 mb-2">
                                        <input
                                            value={t.name}
                                            onChange={(e) => setTheme(i, { name: e.target.value })}
                                            className="flex-1 px-3 py-2 text-sm border border-slate-300 rounded-lg"
                                        />
                                        <div className="flex items-center gap-1">
                                            <input
                                                type="number"
                                                min={0}
                                                max={100}
                                                value={t.sharePercent}
                                                onChange={(e) => setTheme(i, { sharePercent: Number(e.target.value) })}
                                                className="w-20 px-2 py-2 text-sm border border-slate-300 rounded-lg"
                                            />
                                            <span className="text-sm text-slate-500">%</span>
                                        </div>
                                        <button
                                            onClick={() => patch({ themes: plan.themes.filter((_, k) => k !== i) })}
                                            className="p-1 text-slate-400 hover:text-red-600"
                                            aria-label="Remove"
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                    </div>
                                    <div className="flex flex-wrap gap-3">
                                        {NETWORKS.map((n) => (
                                            <label key={n.key} className="flex items-center gap-1.5 text-xs text-slate-600">
                                                <input
                                                    type="checkbox"
                                                    checked={t.networks?.includes(n.key) ?? false}
                                                    onChange={(e) => {
                                                        const current = t.networks ?? [];
                                                        setTheme(i, {
                                                            networks: e.target.checked
                                                                ? [...current, n.key]
                                                                : current.filter((k) => k !== n.key),
                                                        });
                                                    }}
                                                />
                                                {n.label}
                                            </label>
                                        ))}
                                    </div>
                                </div>
                            ))}
                            <div className="flex items-center justify-between">
                                <button
                                    onClick={() => patch({ themes: [...plan.themes, { name: "", sharePercent: 0, networks: [] }] })}
                                    className="flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900"
                                >
                                    <Plus size={14} /> Add a theme
                                </button>
                                <span className={`text-sm ${themeTotal === 100 ? "text-slate-500" : "text-amber-700"}`}>
                                    {themeTotal}% allocated
                                    {themeTotal !== 100 && ", not 100, which is allowed but worth a glance"}
                                </span>
                            </div>
                        </Section>

                        <Section
                            title="Cadence"
                            hint="Posts per week you can actually sustain, not what you would like to manage. Two good Instagram posts beat five thin ones."
                        >
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                                {NETWORKS.map((n) => (
                                    <label key={n.key} className="flex items-center justify-between gap-2 text-sm">
                                        <span className="text-slate-700">{n.label}{!n.connected && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">{NOT_CONNECTED_BADGE}</span>}</span>
                                        <input
                                            type="number"
                                            min={0}
                                            max={21}
                                            value={plan.cadence?.[n.key] ?? 0}
                                            onChange={(e) =>
                                                patch({ cadence: { ...plan.cadence, [n.key]: Number(e.target.value) } })
                                            }
                                            className="w-20 px-2 py-1.5 text-sm border border-slate-300 rounded-lg"
                                        />
                                    </label>
                                ))}
                            </div>
                            <p className="text-sm text-slate-500 mt-3">
                                {weeklyTotal} posts a week across all networks.
                            </p>
                            <p className="text-xs text-slate-500 mt-1">{CONNECTED_NETWORKS_NOTE}</p>
                        </Section>

                        <Section
                            title="The year's shape"
                            hint="Seasons, term dates, grant deadlines, awareness weeks. A date can be a full date or just a month, like 2026-09."
                        >
                            {plan.anchors.map((a, i) => (
                                <div key={i} className="flex flex-wrap items-start gap-2 mb-2">
                                    <input
                                        value={a.date}
                                        onChange={(e) => setAnchor(i, { date: e.target.value })}
                                        placeholder="2026-09"
                                        className="w-28 px-2 py-2 text-sm border border-slate-300 rounded-lg"
                                    />
                                    <select
                                        value={a.type ?? "other"}
                                        onChange={(e) => setAnchor(i, { type: e.target.value as StrategyAnchor["type"] })}
                                        className="px-2 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                                    >
                                        {ANCHOR_TYPES.map((t) => (
                                            <option key={t} value={t}>
                                                {t}
                                            </option>
                                        ))}
                                    </select>
                                    <input
                                        value={a.label}
                                        onChange={(e) => setAnchor(i, { label: e.target.value })}
                                        className="flex-1 min-w-[12rem] px-3 py-2 text-sm border border-slate-300 rounded-lg"
                                    />
                                    <button
                                        onClick={() => patch({ anchors: plan.anchors.filter((_, k) => k !== i) })}
                                        className="p-1 mt-1.5 text-slate-400 hover:text-red-600"
                                        aria-label="Remove"
                                    >
                                        <Trash2 size={14} />
                                    </button>
                                </div>
                            ))}
                            <button
                                onClick={() => patch({ anchors: [...plan.anchors, { date: "", label: "", type: "other", notes: "" }] })}
                                className="mt-1 flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900"
                            >
                                <Plus size={14} /> Add an anchor
                            </button>
                        </Section>

                        <Section
                            title="This year, quarter by quarter"
                            hint="One priority each. Leave a quarter blank rather than filling it with something you do not mean."
                        >
                            <div className="grid sm:grid-cols-2 gap-3">
                                {(["q1", "q2", "q3", "q4"] as const).map((q) => (
                                    <div key={q}>
                                        <label className="block text-xs font-medium text-slate-500 mb-1">
                                            {QUARTER_LABEL[q]}
                                        </label>
                                        <textarea
                                            value={plan.quarterFocus?.[q] ?? ""}
                                            onChange={(e) =>
                                                patch({ quarterFocus: { ...plan.quarterFocus, [q]: e.target.value } })
                                            }
                                            rows={2}
                                            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                                        />
                                    </div>
                                ))}
                            </div>
                        </Section>

                        <div className="flex items-center justify-between py-2">
                            <p className="text-xs text-slate-500">
                                {plan.updatedByName
                                    ? `Last saved by ${plan.updatedByName}`
                                    : "Never saved"}
                                {plan.updatedAt
                                    ? ` on ${new Date(plan.updatedAt).toLocaleDateString("en-GB", {
                                          day: "numeric",
                                          month: "long",
                                          year: "numeric",
                                      })}`
                                    : ""}
                            </p>
                            <button
                                onClick={save}
                                disabled={saving}
                                className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-slate-800 rounded-lg hover:bg-slate-900 disabled:opacity-50"
                            >
                                <Save size={16} />
                                {saving ? "Saving…" : "Save plan"}
                            </button>
                        </div>
                    </>
                )}
            </div>
        </DashboardLayout>
    );
}
