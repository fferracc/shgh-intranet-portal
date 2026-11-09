"use client";

// The course questions, shared by the Courses page and New Process (25 Sep 2026).
import { Course } from "@/lib/types";
import { COURSE_TYPES, isOneToOne } from "@/lib/courses";

type Props = {
    value: Partial<Course>;
    onChange: (next: Partial<Course>) => void;
    /** Show the code box. Leave it empty to get the next code automatically. */
    showCode?: boolean;
};

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export default function CourseFields({ value, onChange, showCode = true }: Props) {
    const set = (patch: Partial<Course>) => onChange({ ...value, ...patch });
    const setSchedule = (patch: Partial<Course["schedule"]>) =>
        onChange({ ...value, schedule: { day: "Monday", start: "10:00", end: "12:00", frequency: "Weekly", ...value.schedule, ...patch } as Course["schedule"] });
    const oneToOne = isOneToOne(value);
    const typeHint = COURSE_TYPES.find(t => t.value === value.type)?.hint;

    return (
        <div className="space-y-4">
            <div className={showCode ? "grid grid-cols-2 gap-4" : ""}>
                {showCode && (
                    <input placeholder="Course code (leave empty for next code)" className="p-2 border rounded w-full" value={value.code || ""} onChange={e => set({ code: e.target.value })} />
                )}
                <input placeholder="Course name" required className="p-2 border rounded w-full" value={value.name || ""} onChange={e => set({ name: e.target.value })} />
            </div>
            <textarea placeholder="Description" className="w-full p-2 border rounded h-20" value={value.description || ""} onChange={e => set({ description: e.target.value })} />

            <div className="grid grid-cols-2 gap-4">
                <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Type</label>
                    <select className="p-2 border rounded w-full" value={value.type || "Rolling"} onChange={e => set({ type: e.target.value as Course["type"] })}>
                        {COURSE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                </div>
                <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Status</label>
                    <select className="p-2 border rounded w-full" value={value.status || "Planned"} onChange={e => set({ status: e.target.value as Course["status"] })}>
                        <option value="Planned">Planned</option>
                        <option value="Running">Running</option>
                        <option value="Completed">Completed</option>
                        <option value="Cancelled">Cancelled</option>
                    </select>
                </div>
            </div>
            {typeHint && <p className="text-xs text-slate-500 -mt-2">{typeHint}</p>}

            {!oneToOne && (
                <>
                    <h4 className="font-bold text-sm text-slate-500 uppercase">Schedule</h4>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Frequency</label>
                            <select className="p-2 border rounded w-full" value={value.schedule?.frequency || "Weekly"} onChange={e => setSchedule({ frequency: e.target.value as Course["schedule"]["frequency"] })}>
                                <option value="Weekly">Weekly</option>
                                <option value="Bi-weekly">Bi-weekly (every 2 weeks)</option>
                                <option value="Monthly">Monthly</option>
                                <option value="Custom">Custom / specialised</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Day of week</label>
                            <select className="p-2 border rounded w-full" value={value.schedule?.day || "Monday"} onChange={e => setSchedule({ day: e.target.value })}>
                                {DAYS.map(d => <option key={d} value={d}>{d}</option>)}
                            </select>
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <label className="flex items-center gap-2"><span className="text-sm font-medium text-slate-600 w-12">Start:</span>
                            <input type="time" className="p-2 border rounded flex-1" value={value.schedule?.start || ""} onChange={e => setSchedule({ start: e.target.value })} /></label>
                        <label className="flex items-center gap-2"><span className="text-sm font-medium text-slate-600 w-12">End:</span>
                            <input type="time" className="p-2 border rounded flex-1" value={value.schedule?.end || ""} onChange={e => setSchedule({ end: e.target.value })} /></label>
                    </div>
                    {value.schedule?.frequency === "Custom" && (
                        <input placeholder="Describe the schedule (e.g. first Saturday of every month)" className="w-full p-2 border rounded border-blue-300" value={value.schedule?.customNotes || ""} onChange={e => setSchedule({ customNotes: e.target.value })} />
                    )}
                </>
            )}

            <h4 className="font-bold text-sm text-slate-500 uppercase">Dates &amp; location</h4>
            <div className="grid grid-cols-2 gap-4">
                <label className="text-xs text-slate-500">Start date<input type="date" className="p-2 border rounded w-full text-sm text-slate-800" value={value.startDate || ""} onChange={e => set({ startDate: e.target.value })} /></label>
                <label className="text-xs text-slate-500">End date<input type="date" className="p-2 border rounded w-full text-sm text-slate-800" value={value.endDate || ""} onChange={e => set({ endDate: e.target.value })} /></label>
            </div>
            <div className="grid grid-cols-2 gap-4">
                <select className="p-2 border rounded w-full" value={value.setting || "In-Person"} onChange={e => set({ setting: e.target.value })}>
                    <option value="In-Person">In person</option>
                    <option value="Virtual">Online</option>
                </select>
                <input placeholder="Venue name" className="p-2 border rounded w-full" value={value.venue || ""} onChange={e => set({ venue: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-4">
                <input placeholder="Address" className="p-2 border rounded w-full" value={value.address || ""} onChange={e => set({ address: e.target.value })} />
                <input placeholder="Postcode" className="p-2 border rounded w-full" value={value.postcode || ""} onChange={e => set({ postcode: e.target.value })} />
            </div>
        </div>
    );
}
