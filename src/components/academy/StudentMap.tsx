"use client";

import { useEffect, useState, useMemo, useRef } from 'react';
import dynamic from 'next/dynamic';
import { Student } from '@/lib/types';
import 'leaflet/dist/leaflet.css';
import { Loader2 } from 'lucide-react';

// Dynamically import the Leaflet map components to avoid SSR issues
const MapContainer = dynamic(() => import('react-leaflet').then(mod => mod.MapContainer), { ssr: false });
const TileLayer = dynamic(() => import('react-leaflet').then(mod => mod.TileLayer), { ssr: false });
const Marker = dynamic(() => import('react-leaflet').then(mod => mod.Marker), { ssr: false });
const Popup = dynamic(() => import('react-leaflet').then(mod => mod.Popup), { ssr: false });

interface StudentMapProps {
    students: Student[];
}

interface StudentLocation {
    student: Student;
    lat: number;
    lng: number;
}

/** "m6 5qq" and "M65QQ" are the same postcode. */
const postcodeKey = (p: unknown) => String(p || "").replace(/\s+/g, "").toUpperCase();
const BATCH = 100; // postcodes.io bulk lookup takes at most 100 postcodes per request

export default function StudentMap({ students }: StudentMapProps) {
    // Coordinates already looked up, kept between renders so a postcode is only sent once.
    const cache = useRef<Map<string, { lat: number; lng: number } | null>>(new Map());
    const [version, setVersion] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Every distinct postcode (1 Oct 2026: all of them, not only the first 100).
    const postcodeList = useMemo(() => {
        const seen = new Map<string, string>();
        students.forEach(s => {
            const key = postcodeKey(s.postcode);
            if (key.length > 4 && !seen.has(key)) seen.set(key, String(s.postcode).trim().toUpperCase());
        });
        return [...seen.entries()];
    }, [students]);
    const postcodeSignature = postcodeList.map(([k]) => k).sort().join("|");

    useEffect(() => {
        let cancelled = false;
        const missing = postcodeList.filter(([k]) => !cache.current.has(k));
        if (missing.length === 0) return;
        (async () => {
            setLoading(true);
            setError(null);
            let failed = 0;
            try {
                // Only the postcodes are sent, never names or any other detail.
                for (let i = 0; i < missing.length; i += BATCH) {
                    const batch = missing.slice(i, i + BATCH);
                    try {
                        const response = await fetch('https://api.postcodes.io/postcodes', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ postcodes: batch.map(([, p]) => p) }),
                        });
                        if (!response.ok) throw new Error(`postcodes.io ${response.status}`);
                        const data = await response.json();
                        const found = new Map<string, { lat: number; lng: number }>();
                        (data.result || []).forEach((res: any) => {
                            if (res && res.result && typeof res.result.latitude === "number") {
                                found.set(postcodeKey(res.query), { lat: res.result.latitude, lng: res.result.longitude });
                            }
                        });
                        batch.forEach(([k]) => cache.current.set(k, found.get(k) || null));
                    } catch (err) {
                        failed += batch.length;
                        console.error("Error fetching map coordinates.", err);
                    }
                    if (cancelled) return;
                }
                if (failed) setError(`${failed} postcode${failed === 1 ? "" : "s"} could not be looked up. Try again later.`);
            } finally {
                if (!cancelled) { setLoading(false); setVersion(v => v + 1); }
            }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [postcodeSignature]);

    const locations: StudentLocation[] = useMemo(() => {
        const out: StudentLocation[] = [];
        students.forEach(student => {
            const coords = cache.current.get(postcodeKey(student.postcode));
            if (coords) out.push({ student, lat: coords.lat, lng: coords.lng });
        });
        return out;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [students, version]);

    // Ensure Leaflet icons work in Next.js without needing local asset copies
    useEffect(() => {
        if (typeof window !== 'undefined') {
            const L = require('leaflet');
            delete L.Icon.Default.prototype._getIconUrl;
            L.Icon.Default.mergeOptions({
                iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
                iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
                shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
            });
        }
    }, []);

    if (loading) {
        return (
            <div className="w-full h-[400px] flex flex-col items-center justify-center bg-slate-50 border border-slate-200 rounded-xl">
                <Loader2 className="animate-spin text-blue-500 mb-2" size={32} />
                <p className="text-sm text-slate-500 font-medium">Loading Map Data...</p>
            </div>
        );
    }

    if (error && locations.length === 0) {
        return (
            <div className="w-full h-[400px] flex items-center justify-center bg-red-50 text-red-600 border border-red-200 rounded-xl p-4 text-center">
                <p className="text-sm">Unable to load student locations on the map. {error}</p>
            </div>
        );
    }

    if (locations.length === 0) {
        return (
            <div className="w-full h-[400px] flex items-center justify-center bg-slate-50 text-slate-500 border border-slate-200 rounded-xl">
                <p className="text-sm">No valid postcodes found to display on map.</p>
            </div>
        );
    }

    // Center on UK generally if we have points, or avg of points
    const centerLat = locations.reduce((sum, l) => sum + l.lat, 0) / locations.length;
    const centerLng = locations.reduce((sum, l) => sum + l.lng, 0) / locations.length;

    return (
        <div>
        {error && <p className="text-xs text-red-600 mb-2">{error}</p>}
        <div className="w-full h-[400px] rounded-xl overflow-hidden border border-slate-200 shadow-sm relative z-0">
            <MapContainer
                center={[centerLat, centerLng]}
                zoom={10}
                className="w-full h-full"
                scrollWheelZoom={true}
            >
                <TileLayer
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                />
                {locations.map((loc, idx) => (
                    <Marker key={`${loc.student.id}-${idx}`} position={[loc.lat, loc.lng]}>
                        <Popup>
                            <strong>{loc.student.name || "No name"}</strong><br />
                            {loc.student.age ? <>Age: {loc.student.age}<br /></> : null}
                            {loc.student.postcode}
                        </Popup>
                    </Marker>
                ))}
            </MapContainer>
        </div>
        <p className="text-xs text-slate-500 mt-1">{locations.length} of {students.length} students shown. Students without a postcode that can be found are not on the map.</p>
        </div>
    );
}
