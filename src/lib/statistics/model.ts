// Master Statistics page (30 Sep 2026, Franco). The shapes every section is built from, so the
// screen, the print view, the Excel workbook and the Word document all show the same figures.

export type Cell = string | number | null;

export interface StatTable {
    /** Unique on the page: "<sectionId>.<key>". */
    id: string;
    title: string;
    columns: string[];
    rows: Cell[][];
    /** Holds people's names: only goes into a document when "Include names" is ticked. */
    names?: boolean;
    /** Never leaves the screen (students' names): not printed, not exported. */
    screenOnly?: boolean;
    note?: string;
    /** Draw simple bars: which column is the label and which the value. */
    chart?: { label: number; value: number; months?: boolean; percent?: boolean };
}

export interface StatKpi {
    /** Unique on the page. */
    id: string;
    label: string;
    value: Cell;
    /** Short explanation shown under the figure. */
    hint?: string;
    /** A figure for today, not for the reporting period. */
    now?: boolean;
}

export type SectionId =
    | "headline" | "attendance" | "classes" | "students" | "volunteers" | "courses" | "oneToOne"
    | "applications" | "leave" | "policies" | "badges" | "inventory" | "comms" | "ghana" | "quality";

export interface StatSection {
    id: SectionId;
    number: number;
    title: string;
    /** One line: how it is counted. */
    definition: string;
    kpis: StatKpi[];
    tables: StatTable[];
    /** The whole section could not be worked out (for example a permission is missing). */
    unavailable?: string;
    /** Parts that could not be worked out, the rest of the section still shows. */
    notes?: string[];
    link?: { href: string; label: string };
}

export type CourseTypeFilter = "all" | "Rolling" | "Drop-in" | "1-2-1";
export type CourseStatusFilter = "all" | "running" | "finished";

/** What goes into a document. Missing keys mean the default (sections off, KPIs and tables on). */
export interface ReportSelection {
    sections: Record<string, boolean>;
    kpis: Record<string, boolean>;
    tables: Record<string, boolean>;
}

export const fmtCell = (v: Cell): string => (v === null || v === undefined ? "N/A" : typeof v === "number" ? v.toLocaleString("en-GB") : v);
