// What goes into a document (print, Excel, Word, AI prompt), from the ticks on the page.
//   - a section goes in only when its tick is on (off by default, the headline figures on);
//   - inside a ticked section, every KPI tile and table goes in unless its own tick is off;
//   - tables with people's names go in only when "Include names" is ticked;
//   - screen only tables (students' names) never go in.
import type { ReportSelection, StatKpi, StatSection, StatTable } from "./model";

export const DEFAULT_SECTIONS: Record<string, boolean> = { headline: true };

export const sectionOn = (sel: ReportSelection, id: string) => sel.sections[id] ?? DEFAULT_SECTIONS[id] ?? false;
export const kpiOn = (sel: ReportSelection, id: string) => sel.kpis[id] ?? true;
export const tableOn = (sel: ReportSelection, id: string) => sel.tables[id] ?? true;

/** Can this table leave the screen at all with these settings? */
export const tableExportable = (t: StatTable, includeNames: boolean) => !t.screenOnly && (!t.names || includeNames);

export interface DocSection { id: string; number: number; title: string; definition: string; kpis: StatKpi[]; tables: StatTable[]; notes: string[] }

export interface ReportMeta {
    title: string;
    subtitle: string;
    periodText: string;
    filtersText: string;
    notes: string;
    includeNames: boolean;
    generated: string;
}

export function reportSections(sections: StatSection[], sel: ReportSelection, includeNames: boolean): DocSection[] {
    return sections
        .filter(s => sectionOn(sel, s.id))
        .map(s => ({
            id: s.id,
            number: s.number,
            title: s.title,
            definition: s.definition,
            kpis: s.kpis.filter(k => kpiOn(sel, k.id)),
            tables: s.tables.filter(t => tableOn(sel, t.id) && tableExportable(t, includeNames) && t.rows.length > 0),
            notes: [...(s.unavailable ? [s.unavailable] : []), ...(s.notes || []), ...(s.link ? [`See ${s.link.label.replace(/^Open /, "")} in the portal.`] : [])],
        }))
        .filter(s => s.kpis.length > 0 || s.tables.length > 0 || s.notes.length > 0);
}

export function generatedText(now: Date = new Date()): string {
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" }).format(now);
}

/** A file name from the title: "Impact report 2026-09-30.xlsx". */
export function fileName(title: string, ext: string, now: Date = new Date()): string {
    const p = (n: number) => String(n).padStart(2, "0");
    const base = (title.trim() || "Statistics").replace(/[\\/:*?"<>|]+/g, " ").slice(0, 80).trim();
    return `${base} ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}.${ext}`;
}

function download(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------------------------------------------------------------- Excel

function sheetName(wanted: string, used: Set<string>): string {
    const base = (wanted.replace(/[:\\/?*[\]]/g, " ").trim() || "Sheet").slice(0, 31);
    let name = base;
    let n = 2;
    while (used.has(name.toLowerCase())) {
        const tail = ` (${n++})`;
        name = base.slice(0, 31 - tail.length) + tail;
    }
    used.add(name.toLowerCase());
    return name;
}

export async function downloadExcel(docs: DocSection[], meta: ReportMeta): Promise<void> {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    const used = new Set<string>();
    const head: (string | number | null)[][] = [
        [meta.title || "Statistics"],
        ...(meta.subtitle ? [[meta.subtitle]] : []),
        [`Reporting period: ${meta.periodText}`],
        [meta.filtersText],
        [`Produced on ${meta.generated} by Sovereign House GH`],
        ...(meta.notes ? [[meta.notes]] : []),
        [],
        ["Section", "Figure", "Value", "Explanation", "Now or period"],
    ];
    docs.forEach(d => d.kpis.forEach(k => head.push([`${d.number}. ${d.title}`, k.label, k.value, k.hint || "", k.now ? "Now" : "Period"])));
    const summary = XLSX.utils.aoa_to_sheet(head);
    summary["!cols"] = [{ wch: 34 }, { wch: 38 }, { wch: 14 }, { wch: 56 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, summary, sheetName("Summary", used));

    docs.forEach(d => {
        if (d.tables.length === 0 && d.notes.length === 0) return;
        const rows: (string | number | null)[][] = [[`${d.number}. ${d.title}`], [d.definition]];
        d.notes.forEach(n => rows.push([n]));
        d.tables.forEach(t => {
            rows.push([], [t.title]);
            if (t.note) rows.push([t.note]);
            rows.push(t.columns);
            t.rows.forEach(r => rows.push(r.map(c => (c === null ? "N/A" : c))));
        });
        const ws = XLSX.utils.aoa_to_sheet(rows);
        const widest = Math.max(1, ...d.tables.map(t => t.columns.length));
        ws["!cols"] = Array.from({ length: widest }, (_, i) => ({ wch: i === 0 ? 34 : 16 }));
        XLSX.utils.book_append_sheet(wb, ws, sheetName(`${d.number} ${d.title}`, used));
    });
    XLSX.writeFile(wb, fileName(meta.title, "xlsx"));
}

// ---------------------------------------------------------------- Word

async function logoBytes(): Promise<ArrayBuffer | null> {
    try {
        const res = await fetch("/assets/logo.png");
        if (!res.ok) return null;
        return await res.arrayBuffer();
    } catch {
        return null;
    }
}

export async function downloadWord(docs: DocSection[], meta: ReportMeta): Promise<void> {
    const d = await import("docx");
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType, ShadingType, ImageRun } = d;
    const GREEN = "2C4A00";
    const cellText = (v: string | number | null) => (v === null || v === undefined ? "N/A" : typeof v === "number" ? v.toLocaleString("en-GB") : String(v));

    const makeTable = (columns: string[], rows: (string | number | null)[][]) => new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
            new TableRow({
                tableHeader: true,
                children: columns.map(c => new TableCell({
                    shading: { type: ShadingType.CLEAR, color: "auto", fill: GREEN },
                    children: [new Paragraph({ children: [new TextRun({ text: c, bold: true, color: "FFFFFF", size: 18 })] })],
                })),
            }),
            ...rows.map(r => new TableRow({
                children: r.map((c, i) => new TableCell({
                    children: [new Paragraph({ alignment: i > 0 && typeof c === "number" ? AlignmentType.RIGHT : AlignmentType.LEFT, children: [new TextRun({ text: cellText(c), size: 18 })] })],
                })),
            })),
        ],
    });

    const children: any[] = [];
    const logo = await logoBytes();
    if (logo) {
        try {
            children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ type: "png", data: logo, transformation: { width: 90, height: 90 } })] }));
        } catch { /* no logo */ }
    }
    children.push(
        new Paragraph({ heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, children: [new TextRun({ text: meta.title || "Statistics", color: GREEN })] }),
    );
    if (meta.subtitle) children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: meta.subtitle, size: 28 })] }));
    children.push(
        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `Reporting period: ${meta.periodText}`, size: 22 })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: meta.filtersText, size: 20, color: "555555" })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 300 }, children: [new TextRun({ text: `Sovereign House GH, produced on ${meta.generated}`, size: 20, color: "555555" })] }),
    );
    if (meta.notes) children.push(new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: meta.notes })] }));

    const allKpis = docs.flatMap(s => s.kpis.map(k => ({ s, k })));
    if (allKpis.length > 0) {
        children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: "Key figures", color: GREEN })] }));
        children.push(makeTable(["Figure", "Value", "Explanation"], allKpis.map(({ k }) => [k.label + (k.now ? " (now)" : ""), k.value, k.hint || ""])));
    }
    docs.forEach(s => {
        if (s.tables.length === 0 && s.notes.length === 0) return;
        children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: false, spacing: { before: 400 }, children: [new TextRun({ text: `${s.number}. ${s.title}`, color: GREEN })] }));
        children.push(new Paragraph({ children: [new TextRun({ text: s.definition, italics: true, size: 20, color: "555555" })] }));
        s.notes.forEach(n => children.push(new Paragraph({ children: [new TextRun({ text: n, size: 20, color: "7F4C12" })] })));
        s.tables.forEach(t => {
            children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 240 }, children: [new TextRun({ text: t.title })] }));
            if (t.note) children.push(new Paragraph({ children: [new TextRun({ text: t.note, italics: true, size: 18, color: "555555" })] }));
            children.push(makeTable(t.columns, t.rows));
        });
    });

    const doc = new Document({
        creator: "Sovereign House GH",
        title: meta.title || "Statistics",
        styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
        sections: [{ children }],
    });
    download(await Packer.toBlob(doc), fileName(meta.title, "docx"));
}

// ---------------------------------------------------------------- AI prompt (numbers only)

/** A prompt with figures only: no names (named tables are always left out) and no free text from class reports. */
export function aiPrompt(docs: DocSection[], meta: ReportMeta): string {
    const lines: string[] = [];
    lines.push("You write reports for Sovereign House GH, a UK charity that runs digital skills and STEM classes for children and adults, and a programme in Ghana.");
    lines.push("Write a short, plain English summary (about 300 words) of the figures below for a funder. Use British English. Do not invent any number that is not below. Point out strengths and anything that needs attention.");
    lines.push("");
    lines.push(`Reporting period: ${meta.periodText}. ${meta.filtersText}.`);
    docs.forEach(s => {
        const tables = s.tables.filter(t => !t.names && !t.screenOnly);
        if (s.kpis.length === 0 && tables.length === 0) return;
        lines.push("", `## ${s.title}`);
        s.kpis.forEach(k => lines.push(`- ${k.label}${k.now ? " (now)" : ""}: ${k.value === null ? "not available" : k.value}`));
        tables.forEach(t => {
            lines.push(`${t.title}: ${t.columns.join(" | ")}`);
            t.rows.slice(0, 40).forEach(r => lines.push(`  ${r.map(c => (c === null ? "N/A" : String(c))).join(" | ")}`));
        });
    });
    return lines.join("\n");
}
