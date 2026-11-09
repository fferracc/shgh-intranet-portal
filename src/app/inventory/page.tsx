"use client";

import DashboardLayout from "@/components/layout/DashboardLayout";
import { useEffect, useState } from "react";
import { collection, query, getDocs, doc, updateDoc, onSnapshot, setDoc, deleteDoc, addDoc, serverTimestamp, writeBatch } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Package, Search, ArrowUpDown, Pencil, X, Save, Trash2, Heart, ShieldAlert, Plus, Settings } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import { can } from "@/lib/permissions";

interface Asset {
    id: string;
    description: string;
    code: string;
    location: string;
    pin: string;
    type?: string;
    // For donated
    donatedTo?: string;
    donatedAt?: any;
    // For wasted
    wastedAt?: any;
}

interface InventorySettings {
    types: string[];
    locations: string[];
}

type TabType = 'active' | 'donated' | 'wasted';

/** A copy of an item for the Donated or Wasted list: no PIN, no undefined values. */
function withoutPin(asset: Asset): Record<string, unknown> {
    const copy: Record<string, unknown> = { ...asset };
    delete copy.pin;
    Object.keys(copy).forEach(key => copy[key] === undefined && delete copy[key]);
    return copy;
}

export default function InventoryPage() {
    const { user } = useAuth();
    const isAdmin = can(user, 'inventory');

    // Core State
    const [activeTab, setActiveTab] = useState<TabType>('active');
    const [assets, setAssets] = useState<Asset[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState("");
    const [sortConfig, setSortConfig] = useState<{ key: keyof Asset; direction: 'asc' | 'desc' } | null>({ key: 'code', direction: 'asc' });

    // Settings State
    const [settings, setSettings] = useState<InventorySettings>({ types: ["Laptop"], locations: ["Office"] });
    const [showSettingsModal, setShowSettingsModal] = useState(false);
    const [editSettings, setEditSettings] = useState<InventorySettings>({ types: [], locations: [] });
    const [newType, setNewType] = useState("");
    const [newLoc, setNewLoc] = useState("");

    // Asset Modals
    const [showAddModal, setShowAddModal] = useState(false);
    const [editingAsset, setEditingAsset] = useState<Asset | null>(null);
    const [formAsset, setFormAsset] = useState<Partial<Asset>>({ description: '', code: '', pin: '', type: 'Laptop', location: 'Office' });
    const [isSaving, setIsSaving] = useState(false);

    // Status Modals
    const [donatingAsset, setDonatingAsset] = useState<Asset | null>(null);
    const [donateTo, setDonateTo] = useState("");

    useEffect(() => {
        // Subscribe to settings
        const unsub = onSnapshot(doc(db, "inventorySettings", "config"), (docSnapshot) => {
            if (docSnapshot.exists()) {
                const data = docSnapshot.data() as InventorySettings;
                setSettings({
                    types: data.types || ["Laptop"],
                    locations: data.locations || ["Office"]
                });
                setEditSettings({
                    types: data.types || ["Laptop"],
                    locations: data.locations || ["Office"]
                });
            } else {
                // No saved list yet: show defaults on screen. They are saved only when someone
                // presses Save in the settings box (30 Sep 2026; it used to write silently).
                const defaults = { types: ["Laptop", "Tablet", "Robot"], locations: ["Main Office", "Storage Hub"] };
                setSettings(defaults);
                setEditSettings(defaults);
            }
        });
        return () => unsub();
    }, []);

    const fetchAssets = async () => {
        setLoading(true);
        try {
            let collectionName = "laptopInventory";
            if (activeTab === 'donated') collectionName = "donatedInventory";
            if (activeTab === 'wasted') collectionName = "wastedInventory";

            const q = query(collection(db, collectionName));
            const snapshot = await getDocs(q);
            const data: Asset[] = [];
            snapshot.forEach(doc => {
                const d = doc.data();
                data.push({
                    id: doc.id,
                    description: d.description || d.name || "Unknown Asset",
                    code: d.code || d.serialNumber || "",
                    location: d.location || "Unknown",
                    // No "N/A" placeholder: it used to be saved back as the PIN on the next edit.
                    pin: d.pin && d.pin !== "N/A" ? d.pin : "",
                    type: d.type || "Laptop",
                    donatedTo: d.donatedTo,
                    donatedAt: d.donatedAt?.toDate ? d.donatedAt.toDate().toLocaleDateString() : d.donatedAt,
                    wastedAt: d.wastedAt?.toDate ? d.wastedAt.toDate().toLocaleDateString() : d.wastedAt
                });
            });

            setAssets(data);
        } catch (error) {
            console.error("Error fetching inventory:", error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchAssets();
    }, [activeTab]);


    // --- Actions ---

    const handleSort = (key: keyof Asset) => {
        let direction: 'asc' | 'desc' = 'asc';
        if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
            direction = 'desc';
        }
        setSortConfig({ key, direction });
    };

    const handleSaveAsset = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSaving(true);
        try {
            const payload = {
                description: formAsset.description,
                code: formAsset.code,
                pin: formAsset.pin || "",
                type: formAsset.type || settings.types[0],
                location: formAsset.location || settings.locations[0],
            };

            if (editingAsset) {
                await updateDoc(doc(db, "laptopInventory", editingAsset.id), payload);
            } else {
                await addDoc(collection(db, "laptopInventory"), { ...payload, createdAt: serverTimestamp() });
            }

            fetchAssets();
            setEditingAsset(null);
            setShowAddModal(false);
        } catch (error) {
            console.error(error);
            alert("Error saving asset.");
        } finally {
            setIsSaving(false);
        }
    };

    const handleWasteAsset = async (asset: Asset) => {
        if (!confirm(`Are you sure you want to mark "${asset.description}" as WASTED? This will remove it from active inventory.`)) return;
        try {
            // The PIN is not copied: the device has left (30 Sep 2026). One batch, so the item is
            // never in both lists or in neither.
            const batch = writeBatch(db);
            batch.set(doc(db, "wastedInventory", asset.id), {
                ...withoutPin(asset),
                wastedAt: serverTimestamp(),
                wastedBy: user?.email || "Unknown"
            });
            batch.delete(doc(db, "laptopInventory", asset.id));
            await batch.commit();
            setAssets(prev => prev.filter(a => a.id !== asset.id));
        } catch (e) {
            console.error(e);
            alert("Failed to waste asset.");
        }
    };

    const submitDonation = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!donatingAsset || !donateTo) return;
        setIsSaving(true);
        try {
            const batch = writeBatch(db);
            batch.set(doc(db, "donatedInventory", donatingAsset.id), {
                ...withoutPin(donatingAsset),
                donatedTo: donateTo,
                donatedAt: serverTimestamp(),
                donatedBy: user?.email || "Unknown"
            });
            batch.delete(doc(db, "laptopInventory", donatingAsset.id));
            await batch.commit();
            setAssets(prev => prev.filter(a => a.id !== donatingAsset.id));
            setDonatingAsset(null);
            setDonateTo("");
        } catch (e) {
            console.error(e);
            alert("Failed to donate asset.");
        } finally {
            setIsSaving(false);
        }
    };

    const restoreAsset = async (asset: Asset, fromCollection: 'donatedInventory' | 'wastedInventory') => {
        if (!confirm(`Restore "${asset.description}" back to the active inventory?\n\nIts PIN was not kept when it left, so add it again with Edit.`)) return;
        try {
            const safeAsset: any = { ...asset };

            // Strip out the extra fields added when moving to these collections
            delete safeAsset.donatedTo;
            delete safeAsset.donatedAt;
            delete safeAsset.donatedBy;
            delete safeAsset.wastedAt;
            delete safeAsset.wastedBy;

            // Ensure no undefined values are written
            Object.keys(safeAsset).forEach(key => safeAsset[key] === undefined && delete safeAsset[key]);

            // One batch: back to the active list and out of the other list together.
            const batch = writeBatch(db);
            batch.set(doc(db, "laptopInventory", asset.id), safeAsset);
            batch.delete(doc(db, fromCollection, asset.id));
            await batch.commit();

            // 3. Remove from UI
            setAssets(prev => prev.filter(a => a.id !== asset.id));
        } catch (e) {
            console.error(e);
            alert("Failed to restore asset.");
        }
    };

    const saveSettings = async () => {
        try {
            await setDoc(doc(db, "inventorySettings", "config"), editSettings);
            setShowSettingsModal(false);
        } catch (e) {
            console.error(e);
            alert("Failed to save categories.");
        }
    };

    const addSettingValue = (key: 'types' | 'locations', val: string, setVal: any) => {
        if (!val.trim()) return;
        setEditSettings(prev => ({ ...prev, [key]: [...prev[key], val.trim()] }));
        setVal("");
    };

    const removeSettingValue = (key: 'types' | 'locations', idx: number) => {
        setEditSettings(prev => ({ ...prev, [key]: prev[key].filter((_, i) => i !== idx) }));
    };


    // --- Render Helpers ---

    const sortedAssets = [...assets].sort((a, b) => {
        if (!sortConfig) return 0;
        const aValue = a[sortConfig.key]?.toString().toLowerCase() || "";
        const bValue = b[sortConfig.key]?.toString().toLowerCase() || "";

        if (aValue < bValue) return sortConfig.direction === 'asc' ? -1 : 1;
        if (aValue > bValue) return sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
    });

    const filteredAssets = sortedAssets.filter(asset =>
        asset.description.toLowerCase().includes(searchTerm.toLowerCase()) ||
        String(asset.code || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
        asset.location.toLowerCase().includes(searchTerm.toLowerCase()) ||
        asset.pin?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        asset.type?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        asset.donatedTo?.toLowerCase().includes(searchTerm.toLowerCase())
    );

    return (
        <DashboardLayout>
            <div className="flex flex-col md:flex-row md:items-center justify-between mb-8 gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-slate-800">Inventory Management</h1>
                    <p className="text-slate-500">Track company assets, devices, and equipment history.</p>
                </div>

                <div className="flex items-center gap-3">
                    <div className="relative">
                        <Search className="absolute left-3 top-2.5 text-slate-400" size={20} />
                        <input
                            type="text"
                            placeholder="Search assets..."
                            className="pl-10 pr-4 py-2 border border-slate-200 rounded-lg w-full md:w-64 focus:ring-2 focus:ring-[#7f4c12] outline-none"
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                        />
                    </div>
                    {isAdmin && activeTab === 'active' && (
                        <>
                            <button onClick={() => { setFormAsset({ type: settings.types[0], location: settings.locations[0] }); setShowAddModal(true); }} className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition font-medium">
                                <Plus size={18} /> Add
                            </button>
                            <button onClick={() => setShowSettingsModal(true)} className="p-2 border border-slate-200 text-slate-500 hover:bg-slate-50 rounded-lg transition" title="Manage Categories">
                                <Settings size={20} />
                            </button>
                        </>
                    )}
                </div>
            </div>

            {/* Tabs */}
            <div className="flex gap-2 border-b border-slate-200 mb-6 overflow-x-auto pb-1">
                {[
                    { id: 'active', label: 'Active Inventory', icon: Package },
                    { id: 'donated', label: 'Donated Setup', icon: Heart },
                    { id: 'wasted', label: 'Wasted / Broken', icon: ShieldAlert }
                ].map(tab => {
                    const Icon = tab.icon;
                    return (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id as TabType)}
                            className={cn(
                                "flex items-center gap-2 px-4 py-3 text-sm font-medium rounded-t-lg transition-colors whitespace-nowrap",
                                activeTab === tab.id
                                    ? "bg-white border text-blue-600 border-b-white -mb-px"
                                    : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
                            )}
                        >
                            <Icon size={18} />
                            {tab.label}
                        </button>
                    );
                })}
            </div>

            {/* Main Table */}
            <div className="rounded-xl shadow-sm border overflow-hidden" style={{ backgroundColor: 'white', borderColor: '#e2e8f0' }}>
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm text-slate-600">
                        <thead className="bg-slate-50 border-b border-slate-100 uppercase tracking-wider font-semibold text-xs text-slate-500">
                            <tr>
                                <th className="p-4 cursor-pointer hover:bg-slate-100" onClick={() => handleSort('description')}>
                                    <div className="flex items-center gap-1">Asset Name <ArrowUpDown size={14} className="text-slate-400" /></div>
                                </th>
                                <th className="p-4 cursor-pointer hover:bg-slate-100" onClick={() => handleSort('type')}>
                                    <div className="flex items-center gap-1">Type <ArrowUpDown size={14} className="text-slate-400" /></div>
                                </th>
                                <th className="p-4 cursor-pointer hover:bg-slate-100" onClick={() => handleSort('code')}>
                                    <div className="flex items-center gap-1">Code <ArrowUpDown size={14} className="text-slate-400" /></div>
                                </th>
                                <th className="p-4 cursor-pointer hover:bg-slate-100" onClick={() => handleSort('location')}>
                                    <div className="flex items-center gap-1">
                                        {activeTab === 'active' ? 'Location' : 'Where it was before'}
                                        <ArrowUpDown size={14} className="text-slate-400" />
                                    </div>
                                </th>

                                {/* Tab Specific Columns */}
                                {activeTab === 'active' && <th className="p-4">Pin</th>}
                                {activeTab === 'donated' && <th className="p-4">Donated To</th>}
                                {activeTab === 'wasted' && <th className="p-4 text-center">Date Wasted</th>}

                                {isAdmin && <th className="p-4 text-right">Actions</th>}
                            </tr>
                        </thead>
                        {loading ? (
                            <tbody><tr><td colSpan={6} className="p-8 text-center text-slate-400">Loading directory...</td></tr></tbody>
                        ) : (
                            <tbody className="divide-y divide-slate-100">
                                {filteredAssets.length === 0 ? (
                                    <tr><td colSpan={6} className="p-8 text-center text-slate-400">No assets found in this category.</td></tr>
                                ) : (
                                    filteredAssets.map(asset => (
                                        <tr key={asset.id} className="hover:bg-slate-50 transition-colors">
                                            <td className="p-4 font-medium text-slate-900">
                                                {asset.description}
                                            </td>
                                            <td className="p-4 text-slate-600">
                                                <span className="bg-slate-100 px-2 py-1 rounded text-xs font-semibold">{asset.type}</span>
                                            </td>
                                            <td className="p-4 font-mono text-xs text-slate-500">
                                                {asset.code || "No code"}
                                            </td>
                                            <td className="p-4">
                                                {asset.location}
                                            </td>

                                            {activeTab === 'active' && <td className="p-4 font-mono text-xs text-slate-500">{asset.pin || "None"}</td>}
                                            {activeTab === 'donated' && (
                                                <td className="p-4">
                                                    <div className="font-semibold text-slate-800">{asset.donatedTo}</div>
                                                    <div className="text-xs text-slate-400">{asset.donatedAt}</div>
                                                </td>
                                            )}
                                            {activeTab === 'wasted' && <td className="p-4 text-center text-slate-500">{asset.wastedAt}</td>}

                                            {isAdmin && activeTab === 'active' && (
                                                <td className="p-4 text-right space-x-1 whitespace-nowrap">
                                                    <button onClick={() => setDonatingAsset(asset)} className="p-2 text-pink-600 hover:bg-pink-50 rounded-lg transition" title="Donate Asset">
                                                        <Heart size={16} />
                                                    </button>
                                                    <button onClick={() => handleWasteAsset(asset)} className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition" title="Mark Wasted">
                                                        <ShieldAlert size={16} />
                                                    </button>
                                                    <button onClick={() => { setFormAsset(asset); setEditingAsset(asset); setShowAddModal(true); }} className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition" title="Edit Asset">
                                                        <Pencil size={16} />
                                                    </button>
                                                </td>
                                            )}

                                            {isAdmin && activeTab !== 'active' && (
                                                <td className="p-4 text-right">
                                                    <button
                                                        onClick={() => restoreAsset(asset, activeTab === 'donated' ? 'donatedInventory' : 'wastedInventory')}
                                                        className="px-3 py-1.5 text-xs font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition"
                                                        title="Restore to active inventory"
                                                    >
                                                        Restore
                                                    </button>
                                                </td>
                                            )}
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        )}
                    </table>
                </div>
            </div>

            {/* Modal: Add/Edit Asset */}
            {showAddModal && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-xl shadow-lg w-full max-w-md overflow-hidden">
                        <div className="flex justify-between items-center p-4 border-b border-slate-100">
                            <h3 className="font-bold text-slate-800">{editingAsset ? "Edit Asset" : "Add New Asset"}</h3>
                            <button onClick={() => setShowAddModal(false)} className="text-slate-400 hover:text-slate-600"><X size={20} /></button>
                        </div>
                        <form onSubmit={handleSaveAsset} className="p-4 space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">Asset Description / Name</label>
                                <input type="text" required className="w-full p-2 border rounded-lg focus:ring-2 outline-none" value={formAsset.description} onChange={e => setFormAsset({ ...formAsset, description: e.target.value })} />
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-medium text-slate-700 mb-1">Type</label>
                                    <select className="w-full p-2 border rounded-lg focus:ring-2 outline-none bg-white" value={formAsset.type} onChange={e => setFormAsset({ ...formAsset, type: e.target.value })}>
                                        {settings.types.map(t => <option key={t} value={t}>{t}</option>)}
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-slate-700 mb-1">Location</label>
                                    <select className="w-full p-2 border rounded-lg focus:ring-2 outline-none bg-white" value={formAsset.location} onChange={e => setFormAsset({ ...formAsset, location: e.target.value })}>
                                        {settings.locations.map(l => <option key={l} value={l}>{l}</option>)}
                                    </select>
                                </div>
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-medium text-slate-700 mb-1">Serial / Code</label>
                                    <input type="text" required className="w-full p-2 border rounded-lg focus:ring-2 outline-none" value={formAsset.code} onChange={e => setFormAsset({ ...formAsset, code: e.target.value })} />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-slate-700 mb-1">Pin (Optional)</label>
                                    <input type="text" className="w-full p-2 border rounded-lg focus:ring-2 outline-none" value={formAsset.pin} onChange={e => setFormAsset({ ...formAsset, pin: e.target.value })} />
                                </div>
                            </div>
                            <div className="flex justify-end gap-3 pt-4 border-t border-slate-50 mt-4">
                                <button type="button" onClick={() => setShowAddModal(false)} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 rounded-lg">Cancel</button>
                                <button type="submit" disabled={isSaving} className="flex flex-row items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50">
                                    <Save size={16} /> {isSaving ? "Saving..." : "Save Asset"}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Modal: Settings config */}
            {showSettingsModal && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-xl shadow-lg w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
                        <div className="flex justify-between items-center p-4 border-b border-slate-100">
                            <div>
                                <h3 className="font-bold text-slate-800">Inventory Categories</h3>
                                <p className="text-xs text-slate-500">Add or remove options from the Dropdown lists.</p>
                            </div>
                            <button onClick={() => setShowSettingsModal(false)} className="text-slate-400"><X size={20} /></button>
                        </div>
                        <div className="p-4 overflow-y-auto space-y-6 flex-1">
                            {/* Types */}
                            <div>
                                <h4 className="font-bold text-sm text-slate-700 mb-2">Item Types</h4>
                                <div className="flex gap-2 mb-3">
                                    <input type="text" placeholder="New type (e.g. Camera)" className="flex-1 p-2 border rounded text-sm outline-none" value={newType} onChange={e => setNewType(e.target.value)} onKeyDown={e => e.key === 'Enter' && addSettingValue('types', newType, setNewType)} />
                                    <button onClick={() => addSettingValue('types', newType, setNewType)} className="px-3 bg-slate-100 hover:bg-slate-200 rounded font-bold text-slate-600"><Plus size={16} /></button>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    {editSettings.types.map((t, idx) => (
                                        <div key={t} className="bg-slate-100 text-slate-700 px-3 py-1 rounded-full text-xs font-semibold flex items-center gap-1">
                                            {t} <button onClick={() => removeSettingValue('types', idx)} className="text-slate-400 hover:text-red-500 ml-1"><X size={12} /></button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                            {/* Locations */}
                            <div>
                                <h4 className="font-bold text-sm text-slate-700 mb-2">Locations</h4>
                                <div className="flex gap-2 mb-3">
                                    <input type="text" placeholder="New location" className="flex-1 p-2 border rounded text-sm outline-none" value={newLoc} onChange={e => setNewLoc(e.target.value)} onKeyDown={e => e.key === 'Enter' && addSettingValue('locations', newLoc, setNewLoc)} />
                                    <button onClick={() => addSettingValue('locations', newLoc, setNewLoc)} className="px-3 bg-slate-100 hover:bg-slate-200 rounded font-bold text-slate-600"><Plus size={16} /></button>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    {editSettings.locations.map((loc, idx) => (
                                        <div key={loc} className="bg-slate-100 text-slate-700 px-3 py-1 rounded-full text-xs font-semibold flex items-center gap-1">
                                            {loc} <button onClick={() => removeSettingValue('locations', idx)} className="text-slate-400 hover:text-red-500 ml-1"><X size={12} /></button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                        <div className="p-4 border-t flex justify-end">
                            <button onClick={saveSettings} className="px-5 py-2 bg-blue-600 text-white rounded font-bold text-sm shadow-sm hover:bg-blue-700 transition">Save Configuration</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Modal: Donate Asset */}
            {donatingAsset && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-xl shadow-lg w-full max-w-sm overflow-hidden p-6 relative">
                        <div className="w-12 h-12 bg-pink-100 text-pink-500 rounded-full flex items-center justify-center mx-auto mb-4">
                            <Heart size={24} />
                        </div>
                        <h3 className="text-center font-bold text-lg mb-1">Donate Asset</h3>
                        <p className="text-center text-sm text-slate-500 mb-6">Moving "<span className="font-semibold text-slate-800">{donatingAsset.description}</span>" from Active Inventory to the Donated log.</p>

                        <form onSubmit={submitDonation}>
                            <label className="block text-sm font-bold text-slate-700 mb-2">To whom was this donated?</label>
                            <input type="text" required autoFocus placeholder="e.g. Saint Jude School" className="w-full p-3 border rounded-lg focus:ring-2 focus:ring-pink-500 outline-none mb-6" value={donateTo} onChange={e => setDonateTo(e.target.value)} />

                            <div className="flex gap-3">
                                <button type="button" onClick={() => setDonatingAsset(null)} className="flex-1 py-2 text-slate-600 font-medium bg-slate-50 hover:bg-slate-100 rounded-lg">Cancel</button>
                                <button type="submit" disabled={isSaving} className="flex-1 py-2 text-white font-medium bg-pink-600 hover:bg-pink-700 disabled:opacity-50 rounded-lg shadow-sm">Confirm Donation</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </DashboardLayout>
    );
}
