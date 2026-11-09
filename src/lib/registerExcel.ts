// Excel download of registers (30 Sep 2026). ONE workbook for any number of courses:
//   - "Summary": one row per course (classes held, students ever, fair attendance %, hours);
//   - one grid sheet per course (named by course code): students x class dates, P / A /
//     blank (not enrolled yet) / "left", totals, and the number present each day;
//   - "Teachers": who taught each class;
//   - "All marks": every mark as a long list (easy to filter or pivot).
// Student names are included: this is an internal download for staff.
import * as XLSX from "xlsx";
import { normType } from "./stats";
import type { SCourse } from "./stats";
import { cellText, ukDate } from "./registers";
import type { RegisterGrid } from "./registers";

export interface CourseRegisterInput { course: SCourse; grid: RegisterGrid }

const RESERVED = new Set(["summary", "teachers", "all marks", "history"]);

/** A valid, unique sheet name (31 characters at most, none of : \ / ? * [ ]). */
function sheetName(wanted: string, used: Set<string>): string {
    const base = (wanted.replace(/[:\\/?*[\]]/g, " ").replace(/^'+|'+$/g, "").trim() || "Course").slice(0, 31);
    let name = base;
    let n = 2;
    while (used.has(name.toLowerCase()) || RESERVED.has(name.toLowerCase())) {
        const tail = ` (${n++})`;
        name = base.slice(0, 31 - tail.length) + tail;
    }
    used.add(name.toLowerCase());
    return name;
}

const pct = (r: number | null | undefined) => (r === null || r === undefined ? "" : r / 100);
const round1 = (n: number) => Math.round(n * 10) / 10;

function setWidths(ws: XLSX.WorkSheet, widths: number[]) {
    ws["!cols"] = widths.map(w => ({ wch: w }));
}

/** Formats a column as a percentage (values stored as fractions). */
function percentColumn(ws: XLSX.WorkSheet, col: number, fromRow: number, toRow: number) {
    for (let r = fromRow; r <= toRow; r++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c: col })];
        if (cell && typeof cell.v === "number") cell.z = "0%";
    }
}

function gridSheet(course: SCourse, grid: RegisterGrid): XLSX.WorkSheet {
    const title = `${course.code || ""} ${course.name || ""}`.trim();
    const header = ["Student", "Note", ...grid.dates.map(ukDate), "Attended", "Expected", "Attendance %"];
    const rows: (string | number)[][] = [
        [title],
        [grid.fair && grid.fair.rate !== null ? `Course attendance (fair method): ${grid.fair.rate}%` : "Course attendance: no data yet"],
        header,
    ];
    grid.students.forEach(s => {
        const note = [s.archived ? "archived" : "", !s.onRoster ? "no longer on the course" : ""].filter(Boolean).join(", ");
        rows.push([s.name, note, ...s.cells.map(cellText), s.attended, s.expected, pct(s.rate)]);
    });
    rows.push(["Students present", "", ...grid.presentByDate, grid.students.reduce((t, s) => t + s.attended, 0), grid.students.reduce((t, s) => t + s.expected, 0), ""]);
    rows.push(["Teachers present", "", ...grid.teachersByDate.map(t => t.length), "", "", ""]);
    if (grid.heldOnlyDates.length) rows.push([`Nobody came (class held): ${grid.heldOnlyDates.map(ukDate).join(", ")}`]);
    if (grid.unlistedStudents) rows.push([`${grid.unlistedStudents} ticked student(s) whose record was deleted are counted in the course rate but not listed.`]);
    rows.push(["P = present, A = absent, blank = not on the course yet, left = no longer on the course"]);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const pctCol = 2 + grid.dates.length + 2;
    percentColumn(ws, pctCol, 3, 3 + grid.students.length);
    setWidths(ws, [28, 22, ...grid.dates.map(() => 11), 9, 9, 13]);
    return ws;
}

export function buildRegistersWorkbook(courses: CourseRegisterInput[]): XLSX.WorkBook {
    const wb = XLSX.utils.book_new();
    const used = new Set<string>();

    // Summary
    const summary: (string | number)[][] = [[
        "Course code", "Course name", "Type", "Status", "Start date", "End date", "Classes held",
        "Students (ever)", "Attendance % (fair method)", "Learner hours", "Teacher hours",
    ]];
    courses.forEach(({ course, grid }) => summary.push([
        course.code || "", course.name || "", normType(course.type), String(course.status || ""),
        ukDate(course.startDate), ukDate(course.endDate), grid.dates.length,
        grid.students.length, pct(grid.fair ? grid.fair.rate : null),
        round1(grid.learnerHours), round1(grid.teacherHours),
    ]));
    const sws = XLSX.utils.aoa_to_sheet(summary);
    percentColumn(sws, 8, 1, courses.length);
    setWidths(sws, [12, 34, 10, 11, 11, 11, 12, 14, 22, 13, 13]);
    XLSX.utils.book_append_sheet(wb, sws, "Summary");

    // One grid per course
    courses.forEach(({ course, grid }) => {
        XLSX.utils.book_append_sheet(wb, gridSheet(course, grid), sheetName(String(course.code || course.name || "Course"), used));
    });

    // Teachers
    const teachers: (string | number)[][] = [["Course code", "Date", "Teacher", "Present"]];
    courses.forEach(({ course, grid }) => grid.dates.forEach((d, i) => {
        // Only real ticks: today's assignments say nothing about who was expected on an old date.
        const here = grid.teachersByDate[i];
        if (here.length === 0) teachers.push([course.code || "", ukDate(d), "No teacher ticked in", "No"]);
        here.forEach(t => teachers.push([course.code || "", ukDate(d), t.name, "Yes"]));
    }));
    const tws = XLSX.utils.aoa_to_sheet(teachers);
    setWidths(tws, [12, 11, 28, 9]);
    XLSX.utils.book_append_sheet(wb, tws, "Teachers");

    // All marks
    const marks: (string | number)[][] = [["Course code", "Course name", "Date", "Person type", "Name", "Status"]];
    courses.forEach(({ course, grid }) => grid.dates.forEach((d, i) => {
        const code = course.code || "", name = course.name || "", day = ukDate(d);
        if (grid.heldOnlyDates.includes(d)) marks.push([code, name, day, "held marker", "", "Class held, nobody came"]);
        grid.teachersByDate[i].forEach(t => marks.push([code, name, day, "teacher", t.name, "present"]));
        grid.students.forEach(s => {
            const c = s.cells[i];
            if (c === "present" || c === "absent") marks.push([code, name, day, "student", s.name, c]);
        });
    }));
    const mws = XLSX.utils.aoa_to_sheet(marks);
    setWidths(mws, [12, 34, 11, 12, 28, 24]);
    XLSX.utils.book_append_sheet(wb, mws, "All marks");

    return wb;
}

/** Builds the workbook and starts the download in the browser. */
export function downloadRegistersExcel(courses: CourseRegisterInput[], filename: string): void {
    const name = /\.xlsx$/i.test(filename) ? filename : `${filename}.xlsx`;
    XLSX.writeFile(buildRegistersWorkbook(courses), name.replace(/[\\/:*?"<>|]+/g, " "));
}
