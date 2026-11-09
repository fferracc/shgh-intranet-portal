"use client";

import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { db } from '@/lib/firebase';
import { collection, addDoc, getDocs, updateDoc, doc } from 'firebase/firestore';
import { Archive, ArchiveRestore, Edit, FileText, Plus, X, Sparkles, ChevronDown, ChevronRight, ExternalLink, CalendarDays, Table2, Award, Layers, Search, CheckCircle2 } from 'lucide-react';
import { AIAssistant } from '@/components/grants/AIAssistant';
import { GrantsGanttChart } from '@/components/grants/GrantsGanttChart';
import { GrantedProjectsChart } from '@/components/grants/GrantedProjectsChart';
import { can } from "@/lib/permissions";
import { AiDraft, AiDraftKind, archiveGrant, Grant, GRANT_STATUSES, moveBrowserMilestones, normaliseGrant, restoreGrant } from '@/lib/grants/grantStore';
import { formatUkDate, toYmd, ymdYear } from '@/lib/grants/dates';

// 1 Oct 2026: grants are archived, never deleted (a main grant asks what happens to its
// sub-grants); milestones and AI drafts live on the grant in Firestore; deadlines are
// 'YYYY-MM-DD' days read the UK way; "Draft" is a status; search covers every grant.
const KIND_LABEL: Record<AiDraftKind, string> = { draft: 'Draft', summary: 'Summary', review: 'Review', idea: 'Idea' };
const money = (n: number) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 }).format(n || 0);

type SortKey = 'index' | 'grantName' | 'funder' | 'amount' | 'deadline' | 'status';

export default function GrantsPage() {
    const { user } = useAuth();
    const [grants, setGrants] = useState<Grant[]>([]);
    const [loading, setLoading] = useState(true);
    const [isAIOpen, setIsAIOpen] = useState(false);
    const [selectedGrantForAI, setSelectedGrantForAI] = useState<Grant | null>(null);

    // Table State
    const [sortKey, setSortKey] = useState<SortKey>('index');
    const [sortAsc, setSortAsc] = useState(false);
    const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
    const [activeView, setActiveView] = useState<'table' | 'timeline' | 'granted' | 'finalised'>('table');
    const [groupBy, setGroupBy] = useState<'none' | 'funder' | 'status' | 'year'>('none');
    const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
    const [searchQuery, setSearchQuery] = useState('');

    // Form State
    const [isDialogOpen, setIsDialogOpen] = useState(false);
    const [currentGrant, setCurrentGrant] = useState<Partial<Grant>>({});
    const [isEditing, setIsEditing] = useState(false);
    const [grantToArchive, setGrantToArchive] = useState<Grant | null>(null);
    const [archiveBusy, setArchiveBusy] = useState(false);
    const [showArchived, setShowArchived] = useState(false);
    const [loadError, setLoadError] = useState('');
    const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
    const [draftsFor, setDraftsFor] = useState<Grant | null>(null);
    const [openDraft, setOpenDraft] = useState<AiDraft | null>(null);
    const [aiInitial, setAiInitial] = useState<{ kind: AiDraftKind; text: string } | null>(null);
    const [aiFromDialog, setAiFromDialog] = useState(false);
    const who = { uid: user?.uid || '', name: user?.displayName || user?.email || '' };

    useEffect(() => {
        if (user) fetchGrants(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user]);
    useEffect(() => { if (notice?.ok) { const t = setTimeout(() => setNotice(null), 8000); return () => clearTimeout(t); } }, [notice]);

    const fetchGrants = async (first = false) => {
        if (first) setLoading(true);
        try {
            const querySnapshot = await getDocs(collection(db, 'grants'));
            const loadedGrants = querySnapshot.docs.map(d => normaliseGrant(d.id, d.data()));
            setGrants(loadedGrants);
            setLoadError('');
            // Milestones that only lived in this browser are copied to their grant once.
            if (first) {
                const moved = await moveBrowserMilestones(loadedGrants, who);
                if (moved) {
                    setNotice({ text: `Milestones for ${moved} grant${moved === 1 ? '' : 's'} were found in this browser and are now saved on the grant for everyone.`, ok: true });
                    fetchGrants();
                }
            }
        } catch (error: any) {
            console.error("Error fetching grants: ", error);
            setLoadError(error?.code === 'permission-denied' ? 'You need the Grants permission to see the grants.' : 'The grants could not be loaded. Check your connection and refresh the page.');
        } finally {
            setLoading(false);
        }
    };

    const active = useMemo(() => grants.filter(g => !g.archived), [grants]);
    const archivedList = useMemo(() => grants.filter(g => g.archived).sort((a, b) => (b.archivedAt || '').localeCompare(a.archivedAt || '')), [grants]);

    const handleSort = (key: SortKey) => {
        if (sortKey === key) {
            setSortAsc(!sortAsc);
        } else {
            setSortKey(key);
            setSortAsc(true);
        }
    };

    const handleSaveGrant = async () => {
        try {
            const dataToSave = {
                ...currentGrant,
                index: currentGrant.index || (grants.length + 1),
                grantName: currentGrant.grantName || 'Untitled',
                funder: currentGrant.funder || 'Unknown',
                description: currentGrant.description || '',
                link: currentGrant.link || '',
                amount: currentGrant.amount || 0,
                amountRequested: currentGrant.amountRequested || 0,
                status: currentGrant.status || 'Have to Apply',
                grantProgress: currentGrant.grantProgress || '',
                deadline: toYmd(currentGrant.deadline) || null,
                parentId: currentGrant.parentId || null
            };
            // Milestones and AI drafts are saved by their own buttons; never overwrite them from an old copy.
            delete (dataToSave as any).id;
            delete (dataToSave as any).milestones;
            delete (dataToSave as any).aiDrafts;

            if (isEditing && currentGrant.id) {
                await updateDoc(doc(db, 'grants', currentGrant.id), dataToSave as any);
            } else {
                await addDoc(collection(db, 'grants'), { ...dataToSave, archived: false, milestones: [], aiDrafts: [], createdAt: new Date().toISOString(), createdBy: who.uid });
            }
            setIsDialogOpen(false);
            setCurrentGrant({});
            setIsEditing(false);
            fetchGrants();
        } catch (error: any) {
            console.error("Error saving grant: ", error);
            alert(`The grant was not saved. ${error?.code === 'permission-denied' ? 'You need the Grants permission.' : error?.message || ''}`);
        }
    };

    const handleDelete = (id: string) => {
        setGrantToArchive(grants.find(g => g.id === id) || null);
    };

    // Archive, never delete. A main grant with sub-grants asks what happens to them.
    const confirmArchive = async (mode: 'standalone' | 'archive') => {
        if (!grantToArchive || archiveBusy) return;
        const children = active.filter(g => g.parentId === grantToArchive.id);
        setArchiveBusy(true);
        try {
            await archiveGrant(grantToArchive, children, mode, who);
            setNotice({ text: `${grantToArchive.grantName} is archived${children.length ? (mode === 'archive' ? ` with its ${children.length} sub-grant${children.length === 1 ? '' : 's'}` : `. Its ${children.length} sub-grant${children.length === 1 ? ' is' : 's are'} now standalone`) : ''}. Find it under Show archived.`, ok: true });
            setGrantToArchive(null);
            fetchGrants();
        } catch (error: any) {
            console.error("Error archiving grant: ", error);
            setNotice({ text: `Not archived. ${error?.code === 'permission-denied' ? 'You need the Grants permission.' : error?.message || ''}`, ok: false });
        } finally { setArchiveBusy(false); }
    };

    const handleRestore = async (g: Grant) => {
        try {
            await restoreGrant(g, grants, who);
            const parentGone = g.parentId && !active.some(p => p.id === g.parentId);
            setNotice({ text: `${g.grantName} is back in the list${parentGone ? '. Its main grant is still archived, so it shows as a standalone grant' : ''}.`, ok: true });
            fetchGrants();
        } catch (error: any) {
            console.error(error);
            setNotice({ text: `Not restored. ${error?.message || ''}`, ok: false });
        }
    };

    const handleStatusChange = async (grantId: string, newStatus: string) => {
        try {
            const grantRef = doc(db, 'grants', grantId);
            await updateDoc(grantRef, { status: newStatus });
            fetchGrants();
        } catch (error) {
            console.error('Error updating status:', error);
        }
    };

    const openEditDialog = (grant: Grant) => {
        setCurrentGrant({ ...grant });
        setIsEditing(true);
        setIsDialogOpen(true);
    };

    const openAddDialog = () => {
        const nextIndex = grants.length > 0 ? Math.max(...grants.map(g => g.index || 0)) + 1 : 1;
        setCurrentGrant({ status: 'Draft', index: nextIndex });
        setIsEditing(false);
        setIsDialogOpen(true);
    };

    const toggleExpand = (id: string) => {
        const next = new Set(expandedRows);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setExpandedRows(next);
    };

    // Search looks through every grant (1 Oct 2026), sub-grants inside closed rows included.
    const matches = (g: Grant, q: string) =>
        [g.grantName, g.funder, g.status, g.description, g.grantProgress, String(g.index || ''), g.deadline ? formatUkDate(g.deadline) : '']
            .some(v => (v || '').toLowerCase().includes(q));

    // Organized Data
    const tableData = useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        const activeIds = new Set(active.map(g => g.id));
        // A sub-grant whose main grant is archived shows as a main grant, so it is never lost.
        const isRoot = (g: Grant) => !g.parentId || !activeIds.has(g.parentId);
        const rootGrants = active.filter(isRoot);

        // Sort root grants
        rootGrants.sort((a, b) => {
            let valA = a[sortKey];
            let valB = b[sortKey];

            if (valA === null || valA === undefined) valA = '';
            if (valB === null || valB === undefined) valB = '';

            if (valA < valB) return sortAsc ? -1 : 1;
            if (valA > valB) return sortAsc ? 1 : -1;
            return 0;
        });

        const rows: { grant: Grant, isChild: boolean, hasChildren: boolean }[] = [];

        rootGrants.forEach(parent => {
            const children = active.filter(g => g.parentId === parent.id);
            // Sort children by deadline descending
            children.sort((a, b) => (b.deadline || '').localeCompare(a.deadline || ''));

            if (q) {
                const hitChildren = children.filter(c => matches(c, q));
                if (!matches(parent, q) && !hitChildren.length) return;
                rows.push({ grant: parent, isChild: false, hasChildren: children.length > 0 });
                (expandedRows.has(parent.id) ? children : hitChildren).forEach(child => rows.push({ grant: child, isChild: true, hasChildren: false }));
                return;
            }

            rows.push({ grant: parent, isChild: false, hasChildren: children.length > 0 });

            if (expandedRows.has(parent.id)) {
                children.forEach(child => {
                    rows.push({ grant: child, isChild: true, hasChildren: false });
                });
            }
        });

        return rows;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, sortKey, sortAsc, expandedRows, searchQuery]);

    const filteredData = tableData;

    const statusColors: Record<string, string> = {
        'Draft': 'bg-slate-100 text-slate-700 border border-dashed border-slate-300',
        'Granted': 'bg-green-100 text-green-800',
        'Application Sent': 'bg-blue-100 text-blue-800',
        'Have to Apply': 'bg-purple-100 text-purple-800',
        'Not Applying': 'bg-slate-100 text-slate-600',
        'Working on it': 'bg-yellow-100 text-yellow-800',
        'Failed': 'bg-red-100 text-red-800',
    };

    const groupKeyOf = (g: Grant) => {
        if (groupBy === 'funder') return g.funder || 'Unknown';
        if (groupBy === 'status') return (g.status === 'Granted' && g.grantProgress === 'Finalised') ? 'Granted (Finalised)' : (g.status || 'Unknown');
        if (groupBy === 'year') return ymdYear(g.deadline || '') || 'Unknown Year';
        return '';
    };
    const toggleGroup = (kind: 'funder' | 'status' | 'year') => {
        const next = groupBy === kind ? 'none' : kind;
        setGroupBy(next);
        if (next !== 'none') {
            const keys = new Set<string>();
            active.forEach(g => {
                keys.add(next === 'funder' ? (g.funder || 'Unknown') : next === 'status' ? ((g.status === 'Granted' && g.grantProgress === 'Finalised') ? 'Granted (Finalised)' : (g.status || 'Unknown')) : (ymdYear(g.deadline || '') || 'Unknown Year'));
            });
            setExpandedGroups(keys);
        }
    };

    const openDrafts = (g: Grant) => { setDraftsFor(g); setOpenDraft(null); };

    const renderRow = ({ grant, isChild, hasChildren }: { grant: Grant; isChild: boolean; hasChildren: boolean }, grouped: boolean) => (
        <tr key={grant.id} className={`border-b transition-colors hover:bg-slate-50/50 ${isChild ? 'bg-slate-50/30' : ''}`}>
            <td className="p-2 align-middle text-center">
                {hasChildren && (
                    <button onClick={(e) => { e.stopPropagation(); toggleExpand(grant.id); }} className="p-1 hover:bg-slate-200 rounded text-slate-500" aria-label={expandedRows.has(grant.id) ? 'Hide sub-grants' : 'Show sub-grants'}>
                        {expandedRows.has(grant.id) ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    </button>
                )}
            </td>
            <td className="p-4 align-middle text-slate-500">{grant.index || '-'}</td>
            <td className={`p-4 align-middle ${grouped ? 'text-xs' : ''} text-slate-600`}>
                {/* The grouped view shows the funder of sub-grants too (1 Oct 2026). */}
                {isChild ? <span className="flex items-center gap-1"><span className="text-slate-400">↳</span>{grant.funder}</span> : grant.funder}
            </td>
            <td className="p-4 align-middle font-medium">
                <div className={`flex items-center gap-2 ${isChild ? `${grouped ? 'pl-4' : 'pl-6'} border-l-2 border-slate-200` : ''}`}>
                    {grant.grantName}
                    {grant.deadline && (
                        <span className="text-xs text-slate-400 font-normal">({ymdYear(grant.deadline)})</span>
                    )}
                </div>
            </td>
            <td className="p-4 align-middle font-medium">{money(grant.amount)}</td>
            <td className="p-4 align-middle text-sm">
                {(grant.status === 'Application Sent' || grant.status === 'Granted') && grant.amountRequested ? (
                    <span className="text-emerald-700 font-medium">{money(grant.amountRequested)}</span>
                ) : <span className="text-slate-300">—</span>}
            </td>
            <td className="p-4 align-middle">
                {grant.deadline ? formatUkDate(grant.deadline) : <span className="text-slate-400">-</span>}
            </td>
            <td className="p-4 align-middle">
                <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${statusColors[grant.status] || 'bg-slate-100 text-slate-800'} ${(grant.status === 'Granted' && grant.grantProgress === 'Finalised') ? 'bg-emerald-100 text-emerald-800 border border-emerald-200' : ''}`}>
                    {grant.status === 'Granted' && grant.grantProgress === 'Finalised' ? 'Granted (Finalised)' : grant.status}
                </span>
            </td>
            <td className="p-4 align-middle">
                {grant.link ? (
                    <a href={grant.link} target="_blank" rel="noreferrer" className="text-purple-600 hover:text-purple-800 p-1 hover:bg-purple-50 rounded inline-block transition-colors">
                        <ExternalLink size={16} />
                    </a>
                ) : <span className="text-slate-300">-</span>}
            </td>
            <td className="p-4 align-middle text-right">
                <div className="flex justify-end gap-1">
                    <button onClick={() => { setSelectedGrantForAI(grant); setAiInitial(null); setAiFromDialog(false); setIsAIOpen(true); }} className="p-2 hover:bg-purple-50 rounded-md transition-colors" title="Use AI Drafter for this grant">
                        <Sparkles className="h-4 w-4 text-purple-500" />
                    </button>
                    <button onClick={() => openDrafts(grant)} className="p-2 hover:bg-slate-100 rounded-md transition-colors relative" title={`AI drafts saved on this grant (${(grant.aiDrafts || []).length})`}>
                        <FileText className="h-4 w-4 text-slate-500" />
                        {(grant.aiDrafts || []).length > 0 && <span className="absolute -top-0.5 -right-0.5 text-[9px] font-bold bg-purple-600 text-white rounded-full min-w-[14px] h-[14px] leading-[14px] px-0.5">{(grant.aiDrafts || []).length}</span>}
                    </button>
                    <button onClick={() => openEditDialog(grant)} className="p-2 hover:bg-slate-100 rounded-md transition-colors" title="Edit">
                        <Edit className="h-4 w-4 text-slate-500" />
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); handleDelete(grant.id); }} className="p-2 hover:bg-amber-50 rounded-md transition-colors" title="Archive">
                        <Archive className="h-4 w-4 text-amber-600" />
                    </button>
                </div>
            </td>
        </tr>
    );

    const archiveChildren = grantToArchive ? active.filter(g => g.parentId === grantToArchive.id) : [];
    const draftsList = draftsFor ? [...(grants.find(g => g.id === draftsFor.id)?.aiDrafts || [])].reverse() : [];
    const inputCls = "flex h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400";

    if (!can(user, 'grants')) {
        return <div className="p-8 text-red-600">Access Denied. Admins only.</div>;
    }

    return (
        <div className="p-8 space-y-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-slate-900">Grants Management</h1>
                    <p className="text-slate-500">Manage funding history, multi-year applications, and track specific deadlines.</p>
                </div>
                <div className="flex gap-3">
                    <button
                        onClick={() => {
                            setSelectedGrantForAI(null);
                            setAiInitial(null);
                            setAiFromDialog(false);
                            setIsAIOpen(true);
                        }}
                        className="inline-flex items-center justify-center rounded-md text-sm font-bold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background bg-purple-100 text-purple-700 hover:bg-purple-200 h-10 py-2 px-4 shadow-sm group"
                    >
                        <Sparkles className="mr-2 h-4 w-4 text-purple-600 group-hover:animate-pulse" />
                        AI Assistant
                    </button>
                    <button
                        onClick={openAddDialog}
                        className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none ring-offset-background bg-slate-900 text-white hover:bg-slate-900/90 h-10 py-2 px-4"
                    >
                        <Plus className="mr-2 h-4 w-4" />
                        Add Grant
                    </button>
                </div>
            </div>

            {loadError && <div role="alert" className="p-4 rounded-lg border border-red-200 bg-red-50 text-sm text-red-700">{loadError}</div>}
            {notice && (
                <div role={notice.ok ? 'status' : 'alert'} className={`fixed z-[70] bottom-6 left-1/2 -translate-x-1/2 w-[min(92vw,36rem)] p-4 rounded-xl shadow-lg border flex items-start gap-3 text-sm ${notice.ok ? 'bg-green-600 border-green-700 text-white' : 'bg-red-600 border-red-700 text-white'}`}>
                    <span className="flex-1">{notice.text}</span>
                    <button onClick={() => setNotice(null)} className="font-bold opacity-80 hover:opacity-100" aria-label="Close">×</button>
                </div>
            )}

            {/* Tab Switcher */}
            <div className="flex border-b border-slate-200">
                <button
                    onClick={() => setActiveView('table')}
                    className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold border-b-2 transition-colors ${activeView === 'table' ? 'border-slate-900 text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50'}`}
                >
                    <Table2 size={16} />
                    Grants Table
                </button>
                <button
                    onClick={() => setActiveView('timeline')}
                    className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold border-b-2 transition-colors ${activeView === 'timeline' ? 'border-slate-900 text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50'}`}
                >
                    <CalendarDays size={16} />
                    Timeline
                </button>
                <button
                    onClick={() => setActiveView('granted')}
                    className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold border-b-2 transition-colors ${activeView === 'granted' ? 'border-slate-900 text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50'}`}
                >
                    <Award size={16} />
                    Granted Projects
                </button>
                <button
                    onClick={() => setActiveView('finalised')}
                    className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold border-b-2 transition-colors ${activeView === 'finalised' ? 'border-slate-900 text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50'}`}
                >
                    <CheckCircle2 size={16} />
                    Finalised Projects
                </button>
            </div>

            {/* Timeline View */}
            {activeView === 'timeline' && !loading && (
                <GrantsGanttChart grants={active} />
            )}

            {/* Granted Projects View */}
            {activeView === 'granted' && !loading && (
                <GrantedProjectsChart grants={active} onStatusChange={handleStatusChange} isFinalisedView={false} />
            )}

            {/* Finalised Projects View */}
            {activeView === 'finalised' && !loading && (
                <GrantedProjectsChart grants={active} onStatusChange={handleStatusChange} isFinalisedView={true} />
            )}

            {/* Table View */}
            {activeView === 'table' && (
                <div className="bg-white rounded-lg border shadow-sm overflow-hidden">
                    {/* Search + Group by Funder toolbar */}
                    <div className="px-4 py-2 border-b bg-slate-50/50 flex flex-wrap items-center justify-between gap-3">
                        <div className="relative flex-1 max-w-xs">
                            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                            <input
                                type="text"
                                placeholder="Search every grant..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="w-full h-8 pl-8 pr-3 text-xs rounded-md border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-slate-400 focus:border-transparent placeholder:text-slate-400"
                            />
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {(['funder', 'status', 'year'] as const).map(kind => (
                                <button
                                    key={kind}
                                    onClick={() => toggleGroup(kind)}
                                    className={`text-xs font-semibold px-3 py-1.5 rounded-full flex items-center gap-1.5 transition-colors whitespace-nowrap ${groupBy === kind ? 'bg-purple-100 text-purple-700 border border-purple-200' : 'bg-slate-100 text-slate-600 border border-slate-200 hover:bg-slate-200'}`}
                                >
                                    <Layers size={13} />
                                    {groupBy === kind ? `Grouped by ${kind === 'funder' ? 'Funder' : kind === 'status' ? 'Status' : 'Year'}` : `Group by ${kind === 'funder' ? 'Funder' : kind === 'status' ? 'Status' : 'Year'}`}
                                </button>
                            ))}
                            <button
                                onClick={() => setShowArchived(v => !v)}
                                className={`text-xs font-semibold px-3 py-1.5 rounded-full flex items-center gap-1.5 transition-colors whitespace-nowrap ${showArchived ? 'bg-amber-100 text-amber-800 border border-amber-200' : 'bg-slate-100 text-slate-600 border border-slate-200 hover:bg-slate-200'}`}
                            >
                                <Archive size={13} />
                                {showArchived ? 'Hide archived' : `Show archived (${archivedList.length})`}
                            </button>
                        </div>
                    </div>
                    <div className="relative w-full overflow-auto">
                        <table className="w-full caption-bottom text-sm text-left">
                            <thead className="[&_tr]:border-b bg-slate-50">
                                <tr className="border-b transition-colors">
                                    <th className="h-12 w-12 px-2"></th>
                                    <th className="h-12 px-4 align-middle font-medium text-slate-500 cursor-pointer hover:bg-slate-100" onClick={() => handleSort('index')}>#</th>
                                    <th className="h-12 px-4 align-middle font-medium text-slate-500 cursor-pointer hover:bg-slate-100" onClick={() => handleSort('funder')}>Funder</th>
                                    <th className="h-12 px-4 align-middle font-medium text-slate-500 cursor-pointer hover:bg-slate-100" onClick={() => handleSort('grantName')}>Grant Name (Year)</th>
                                    <th className="h-12 px-4 align-middle font-medium text-slate-500 cursor-pointer hover:bg-slate-100" onClick={() => handleSort('amount')}>Amount (Max)</th>
                                    <th className="h-12 px-4 align-middle font-medium text-slate-500">Requested</th>
                                    <th className="h-12 px-4 align-middle font-medium text-slate-500 cursor-pointer hover:bg-slate-100" onClick={() => handleSort('deadline')}>Deadline</th>
                                    <th className="h-12 px-4 align-middle font-medium text-slate-500 cursor-pointer hover:bg-slate-100" onClick={() => handleSort('status')}>Status</th>
                                    <th className="h-12 px-4 align-middle font-medium text-slate-500">Link</th>
                                    <th className="h-12 px-4 align-middle font-medium text-slate-500 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="[&_tr:last-child]:border-0">
                                {loading ? (
                                    <tr><td colSpan={10} className="text-center py-8">Loading grants...</td></tr>
                                ) : filteredData.length === 0 ? (
                                    <tr><td colSpan={10} className="text-center py-8 text-slate-500">{searchQuery ? 'No grants match your search.' : 'No grants found. Add one to get started.'}</td></tr>
                                ) : groupBy !== 'none' ? (
                                    (() => {
                                        const dataGroups: Record<string, typeof filteredData> = {};
                                        filteredData.forEach(item => {
                                            const key = groupKeyOf(item.grant);
                                            if (!dataGroups[key]) dataGroups[key] = [];
                                            dataGroups[key].push(item);
                                        });
                                        return Object.entries(dataGroups).sort(([a], [b]) => a.localeCompare(b)).map(([groupKey, items]) => {
                                            const isExpanded = expandedGroups.has(groupKey) || !!searchQuery.trim();
                                            const totalAmount = items.reduce((s, i) => s + (i.grant.amount || 0), 0);
                                            return (
                                                <React.Fragment key={`grp-${groupKey}`}>
                                                    <tr
                                                        className="border-b bg-purple-50/40 cursor-pointer hover:bg-purple-50/70 transition-colors"
                                                        onClick={() => {
                                                            const next = new Set(expandedGroups);
                                                            if (isExpanded) next.delete(groupKey); else next.add(groupKey);
                                                            setExpandedGroups(next);
                                                        }}
                                                    >
                                                        <td className="p-2 text-center text-purple-600">
                                                            {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                                                        </td>
                                                        <td className="p-3" colSpan={2}>
                                                            <span className="font-bold text-sm text-slate-800">{groupKey}</span>
                                                            <span className="ml-2 text-[10px] text-slate-400 font-medium">{items.length} grant{items.length !== 1 ? 's' : ''}</span>
                                                        </td>
                                                        <td className="p-3 text-xs text-slate-500"></td>
                                                        <td className="p-3 text-xs font-semibold text-slate-600">{money(totalAmount)}</td>
                                                        <td colSpan={5}></td>
                                                    </tr>
                                                    {isExpanded && items.map(item => renderRow(item, true))}
                                                </React.Fragment>
                                            );
                                        });
                                    })()
                                ) : (
                                    filteredData.map(item => renderRow(item, false))
                                )}
                            </tbody>
                        </table>
                    </div>

                    {/* Archived grants (1 Oct 2026): never deleted, hidden until asked for. */}
                    {showArchived && (
                        <div className="border-t bg-amber-50/30">
                            <div className="px-4 py-3 flex items-center gap-2 text-sm font-bold text-slate-700"><Archive size={15} className="text-amber-600" /> Archived grants</div>
                            {archivedList.length === 0 ? <p className="px-4 pb-4 text-sm text-slate-500">Nothing is archived.</p> : (
                                <ul className="divide-y border-t">
                                    {archivedList.map(g => (
                                        <li key={g.id} className="px-4 py-2.5 flex flex-wrap items-center gap-3 text-sm">
                                            <span className="font-medium text-slate-800">{g.grantName}</span>
                                            <span className="text-slate-500">{g.funder}</span>
                                            {g.archivedWith && <span className="text-xs text-slate-400">archived with {grants.find(p => p.id === g.archivedWith)?.grantName || 'its main grant'}</span>}
                                            <span className="text-xs text-slate-400">{g.archivedAt ? `Archived ${new Date(g.archivedAt).toLocaleDateString('en-GB', { timeZone: 'Europe/London' })}${g.archivedByName ? ` by ${g.archivedByName}` : ''}` : ''}</span>
                                            <button onClick={() => handleRestore(g)} className="ml-auto text-xs font-semibold px-3 py-1.5 rounded-md border border-slate-300 bg-white hover:bg-slate-50 flex items-center gap-1"><ArchiveRestore size={13} /> Restore</button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Modal Dialog */}
            {isDialogOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 overflow-y-auto">
                    <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl p-6 relative my-8">
                        <button
                            onClick={() => setIsDialogOpen(false)}
                            className="absolute top-4 right-4 text-slate-400 hover:text-slate-600 transition-colors"
                            aria-label="Close"
                        >
                            <X className="h-5 w-5" />
                        </button>
                        <h2 className="text-xl font-bold leading-none tracking-tight mb-6">{isEditing ? 'Edit Grant' : 'Add New Grant'}</h2>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                            <div className="grid gap-2">
                                <label className="text-sm font-medium leading-none">Index / Row #</label>
                                <input
                                    type="number"
                                    className={inputCls}
                                    value={currentGrant.index || ''}
                                    onChange={(e) => setCurrentGrant({ ...currentGrant, index: parseInt(e.target.value) })}
                                />
                            </div>
                            <div className="grid gap-2">
                                <label className="text-sm font-medium leading-none">Parent ID (for subsequent years)</label>
                                <select
                                    className={inputCls}
                                    value={currentGrant.parentId || ''}
                                    onChange={(e) => setCurrentGrant({ ...currentGrant, parentId: e.target.value || null })}
                                >
                                    <option value="">None (Top-Level Grant)</option>
                                    {active.filter(g => !g.parentId && g.id !== currentGrant.id).map(g => (
                                        <option key={g.id} value={g.id}>{g.grantName} ({g.funder})</option>
                                    ))}
                                </select>
                            </div>

                            <div className="grid gap-2 md:col-span-2">
                                <label className="text-sm font-medium leading-none">Grant Name</label>
                                <input
                                    className={inputCls}
                                    value={currentGrant.grantName || ''}
                                    onChange={(e) => setCurrentGrant({ ...currentGrant, grantName: e.target.value })}
                                    placeholder="e.g. Community Support Fund"
                                />
                            </div>
                            <div className="grid gap-2 md:col-span-2">
                                <label className="text-sm font-medium leading-none">Funder</label>
                                <input
                                    className={inputCls}
                                    value={currentGrant.funder || ''}
                                    onChange={(e) => setCurrentGrant({ ...currentGrant, funder: e.target.value })}
                                />
                            </div>

                            <div className="grid gap-2 md:col-span-2">
                                <div className="flex justify-between items-center">
                                    <label className="text-sm font-medium leading-none">Description & Eligibility Details</label>
                                </div>
                                <textarea
                                    className="flex min-h-[80px] w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 custom-scrollbar"
                                    value={currentGrant.description || ''}
                                    onChange={(e) => setCurrentGrant({ ...currentGrant, description: e.target.value })}
                                />
                            </div>

                            <div className="grid gap-2 md:col-span-2">
                                <label className="text-sm font-medium leading-none">Website / Document URL</label>
                                <input
                                    className={`${inputCls} text-purple-600`}
                                    value={currentGrant.link || ''}
                                    onChange={(e) => setCurrentGrant({ ...currentGrant, link: e.target.value })}
                                    placeholder="https://..."
                                />
                            </div>

                            <div className="grid gap-2">
                                <label className="text-sm font-medium leading-none">Amount Max (£)</label>
                                <input
                                    type="number"
                                    className={inputCls}
                                    value={currentGrant.amount || ''}
                                    onChange={(e) => setCurrentGrant({ ...currentGrant, amount: parseFloat(e.target.value) })}
                                />
                            </div>
                            <div className="grid gap-2">
                                <label className="text-sm font-medium leading-none">Status</label>
                                <select
                                    className={inputCls}
                                    value={currentGrant.status || 'Have to Apply'}
                                    onChange={(e) => setCurrentGrant({ ...currentGrant, status: e.target.value })}
                                >
                                    {GRANT_STATUSES.map(st => <option key={st} value={st}>{st}</option>)}
                                    {currentGrant.status && !GRANT_STATUSES.includes(currentGrant.status) && <option value={currentGrant.status}>{currentGrant.status}</option>}
                                </select>
                            </div>

                            {(currentGrant.status === 'Application Sent' || currentGrant.status === 'Granted') && (
                                <div className="grid gap-2">
                                    <label className="text-sm font-medium leading-none">Amount Requested (£)</label>
                                    <input
                                        type="number"
                                        className="flex h-10 w-full rounded-md border border-emerald-300 bg-emerald-50/30 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                                        value={currentGrant.amountRequested || ''}
                                        onChange={(e) => setCurrentGrant({ ...currentGrant, amountRequested: parseFloat(e.target.value) })}
                                        placeholder="Amount you applied for"
                                    />
                                </div>
                            )}

                            {currentGrant.status === 'Granted' && (
                                <div className="grid gap-2">
                                    <label className="text-sm font-medium leading-none">Grant Progress</label>
                                    <select
                                        className="flex h-10 w-full rounded-md border border-green-300 bg-green-50/30 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-400"
                                        value={currentGrant.grantProgress || 'In process'}
                                        onChange={(e) => setCurrentGrant({ ...currentGrant, grantProgress: e.target.value })}
                                    >
                                        <option value="In process">In process</option>
                                        <option value="Finalised">Finalised</option>
                                    </select>
                                </div>
                            )}

                            <div className="grid gap-2">
                                <label className="text-sm font-medium leading-none">Deadline Date</label>
                                {/* Kept as the day itself, 'YYYY-MM-DD' (1 Oct 2026): no one day shift in summer time. */}
                                <input
                                    type="date"
                                    className={inputCls}
                                    value={toYmd(currentGrant.deadline)}
                                    onChange={(e) => setCurrentGrant({ ...currentGrant, deadline: e.target.value || null })}
                                />
                            </div>
                        </div>

                        <div className="flex justify-between items-center mt-8 pt-4 border-t">
                            <button
                                type="button"
                                className="inline-flex items-center justify-center rounded-md text-sm font-bold transition-colors border border-purple-200 bg-purple-50 text-purple-700 hover:bg-purple-100 h-10 py-2 px-4"
                                title={isEditing ? 'Fill in this grant from a link or the funder text' : 'Open Summarizer to auto-extract details from this link or description'}
                                onClick={() => { setSelectedGrantForAI(null); setAiInitial(null); setAiFromDialog(true); setIsAIOpen(true); }}
                            >
                                <Sparkles className="mr-2 h-4 w-4" />
                                Auto-Fill with AI
                            </button>
                            <div className="flex gap-3">
                                <button
                                    onClick={() => setIsDialogOpen(false)}
                                    className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-slate-300 hover:bg-slate-100 h-10 py-2 px-4"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleSaveGrant}
                                    className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors bg-slate-900 text-white hover:bg-slate-900/90 h-10 py-2 px-4 shadow-sm"
                                >
                                    {isEditing ? 'Update Grant' : 'Save New Grant'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Archive Confirmation Modal (archive, never delete) */}
            {grantToArchive && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in">
                    <div className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden animate-in zoom-in-95 p-6 text-center">
                        <Archive className="h-10 w-10 text-amber-500 mx-auto mb-4" />
                        <h3 className="text-lg font-bold text-slate-900 mb-2">Archive {grantToArchive.grantName}?</h3>
                        <p className="text-slate-500 text-sm mb-4">Archived grants are kept and hidden from the lists. You can restore it at any time under Show archived.</p>
                        {archiveChildren.length > 0 && (
                            <div className="text-left text-sm bg-slate-50 border rounded-lg p-3 mb-4">
                                <p className="font-semibold text-slate-700 mb-1">It has {archiveChildren.length} sub-grant{archiveChildren.length === 1 ? '' : 's'}:</p>
                                <ul className="list-disc pl-5 text-slate-600 mb-2">{archiveChildren.slice(0, 6).map(c => <li key={c.id}>{c.grantName}</li>)}{archiveChildren.length > 6 && <li>and {archiveChildren.length - 6} more</li>}</ul>
                                <p className="text-slate-600">Should they stay in the list as standalone grants, or be archived with it?</p>
                            </div>
                        )}
                        <div className="flex flex-wrap justify-center gap-3">
                            <button
                                onClick={(e) => { e.stopPropagation(); setGrantToArchive(null); }}
                                className="px-4 py-2 bg-slate-100 text-slate-700 font-semibold rounded hover:bg-slate-200 transition-colors"
                            >
                                Cancel
                            </button>
                            {archiveChildren.length > 0 ? (
                                <>
                                    <button disabled={archiveBusy} onClick={(e) => { e.stopPropagation(); confirmArchive('standalone'); }}
                                        className="px-4 py-2 bg-white border border-slate-300 text-slate-800 font-semibold rounded hover:bg-slate-50 transition-colors disabled:opacity-60">
                                        Keep sub-grants as standalone
                                    </button>
                                    <button disabled={archiveBusy} onClick={(e) => { e.stopPropagation(); confirmArchive('archive'); }}
                                        className="px-4 py-2 bg-amber-600 text-white font-semibold rounded hover:bg-amber-700 transition-colors shadow-sm disabled:opacity-60">
                                        Archive them too
                                    </button>
                                </>
                            ) : (
                                <button disabled={archiveBusy} onClick={(e) => { e.stopPropagation(); confirmArchive('archive'); }}
                                    className="px-4 py-2 bg-amber-600 text-white font-semibold rounded hover:bg-amber-700 transition-colors shadow-sm disabled:opacity-60">
                                    {archiveBusy ? 'Archiving…' : 'Yes, archive'}
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* AI drafts saved on a grant (1 Oct 2026) */}
            {draftsFor && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm" onClick={() => setDraftsFor(null)}>
                    <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
                        <div className="px-5 py-4 border-b flex items-center gap-2">
                            <FileText className="h-5 w-5 text-purple-600" />
                            <h3 className="font-bold text-slate-900 flex-1">AI drafts for {draftsFor.grantName}</h3>
                            <button onClick={() => setDraftsFor(null)} className="text-slate-400 hover:text-slate-600" aria-label="Close"><X className="h-5 w-5" /></button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-5">
                            {openDraft ? (
                                <div className="space-y-3">
                                    <button onClick={() => setOpenDraft(null)} className="text-sm text-blue-600 hover:underline">Back to the list</button>
                                    <p className="text-xs text-slate-500">{KIND_LABEL[openDraft.kind] || openDraft.kind}, {new Date(openDraft.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/London' })}{openDraft.createdByName ? ` by ${openDraft.createdByName}` : ''}</p>
                                    <div className="p-4 bg-slate-50 border rounded-lg text-sm whitespace-pre-wrap text-slate-800">{openDraft.text}</div>
                                    <div className="flex flex-wrap gap-2">
                                        <button onClick={() => navigator.clipboard?.writeText(openDraft.text)} className="text-sm font-semibold px-3 py-1.5 rounded-md border border-slate-300 hover:bg-slate-50">Copy</button>
                                        <button onClick={() => { setSelectedGrantForAI(draftsFor); setAiInitial({ kind: openDraft.kind, text: openDraft.text }); setAiFromDialog(false); setDraftsFor(null); setIsAIOpen(true); }}
                                            className="text-sm font-semibold px-3 py-1.5 rounded-md bg-purple-600 text-white hover:bg-purple-700 flex items-center gap-1"><Sparkles size={14} /> Open in the AI Assistant</button>
                                    </div>
                                </div>
                            ) : draftsList.length === 0 ? (
                                <p className="text-sm text-slate-500">No AI drafts yet. Open the AI Assistant from this grant (the sparkle button) and every draft, summary and review is saved here.</p>
                            ) : (
                                <ul className="divide-y border rounded-lg">
                                    {draftsList.map((d, i) => (
                                        <li key={`${d.createdAt}-${i}`}>
                                            <button onClick={() => setOpenDraft(d)} className="w-full text-left px-4 py-3 hover:bg-slate-50">
                                                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 mr-2">{KIND_LABEL[d.kind] || d.kind}</span>
                                                <span className="text-xs text-slate-500">{new Date(d.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/London' })}{d.createdByName ? `, ${d.createdByName}` : ''}</span>
                                                <span className="block text-sm text-slate-700 truncate mt-1">{d.text.replace(/[#*]/g, '').trim().split('\n')[0]}</span>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* AI Assistant Floating Panel */}
            {isAIOpen && (
                <AIAssistant
                    onClose={() => {
                        setIsAIOpen(false);
                        setSelectedGrantForAI(null);
                        setAiInitial(null);
                        setAiFromDialog(false);
                    }}
                    preloadedGrant={selectedGrantForAI}
                    initialResult={aiInitial}
                    grants={active.map(g => ({ id: g.id, grantName: g.grantName, funder: g.funder }))}
                    editingGrantName={aiFromDialog && isDialogOpen && isEditing ? (currentGrant.grantName || 'this grant') : undefined}
                    onDraftSaved={(grantId, drafts) => setGrants(list => list.map(g => g.id === grantId ? { ...g, aiDrafts: drafts } : g))}
                    onCreateGrantFromSummary={(prefillData: any) => {
                        // Auto-Fill while editing fills the grant being edited (1 Oct 2026), it no longer makes a copy.
                        if (aiFromDialog && isDialogOpen && isEditing && currentGrant.id) {
                            setCurrentGrant(cur => ({
                                ...cur,
                                funder: prefillData.funder || cur.funder,
                                description: prefillData.description || cur.description,
                                amount: prefillData.amount || cur.amount,
                                deadline: prefillData.deadline || cur.deadline || null,
                                link: prefillData.link || cur.link,
                            }));
                            return;
                        }
                        if (aiFromDialog && isDialogOpen && !isEditing) {
                            setCurrentGrant(cur => ({
                                ...cur,
                                funder: prefillData.funder || cur.funder || '',
                                description: prefillData.description || cur.description || '',
                                amount: prefillData.amount || cur.amount || 0,
                                deadline: prefillData.deadline || cur.deadline || null,
                                link: prefillData.link || cur.link || '',
                            }));
                            return;
                        }
                        const nextIndex = grants.length > 0 ? Math.max(...grants.map(g => g.index || 0)) + 1 : 1;
                        setIsEditing(false);
                        setCurrentGrant({
                            index: nextIndex,
                            grantName: '',
                            funder: prefillData.funder || '',
                            description: prefillData.description || '',
                            amount: prefillData.amount || 0,
                            deadline: prefillData.deadline || null,
                            status: 'Draft',
                            link: prefillData.link || ''
                        });
                        setIsDialogOpen(true);
                    }}
                />
            )}
        </div>
    );
}
