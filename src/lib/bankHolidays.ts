export const UK_BANK_HOLIDAYS_2025_2026 = [
    // 2025
    { date: "2025-01-01", title: "New Year’s Day" },
    { date: "2025-04-18", title: "Good Friday" },
    { date: "2025-04-21", title: "Easter Monday" },
    { date: "2025-05-05", title: "Early May bank holiday" },
    { date: "2025-05-26", title: "Spring bank holiday" },
    { date: "2025-08-25", title: "Summer bank holiday" },
    { date: "2025-12-25", title: "Christmas Day" },
    { date: "2025-12-26", title: "Boxing Day" },
    // 2026
    { date: "2026-01-01", title: "New Year’s Day" },
    { date: "2026-04-03", title: "Good Friday" },
    { date: "2026-04-06", title: "Easter Monday" },
    { date: "2026-05-04", title: "Early May bank holiday" },
    { date: "2026-05-25", title: "Spring bank holiday" },
    { date: "2026-08-31", title: "Summer bank holiday" },
    { date: "2026-12-25", title: "Christmas Day" },
    { date: "2026-12-28", title: "Boxing Day (Substitute)" },
    // 2027 and 2028 added 24 Sep 2026, from GOV.UK (www.gov.uk/bank-holidays.json,
    // division "england-and-wales"). Before this the list stopped at 2026, so from
    // 1 Jan 2027 bank holidays would have been taken out of people's annual leave.
    // GOV.UK publishes about two years ahead: add 2029 once it appears there.
    // 2027
    { date: "2027-01-01", title: "New Year’s Day" },
    { date: "2027-03-26", title: "Good Friday" },
    { date: "2027-03-29", title: "Easter Monday" },
    { date: "2027-05-03", title: "Early May bank holiday" },
    { date: "2027-05-31", title: "Spring bank holiday" },
    { date: "2027-08-30", title: "Summer bank holiday" },
    { date: "2027-12-27", title: "Christmas Day (Substitute)" },
    { date: "2027-12-28", title: "Boxing Day (Substitute)" },
    // 2028
    { date: "2028-01-03", title: "New Year’s Day (Substitute)" },
    { date: "2028-04-14", title: "Good Friday" },
    { date: "2028-04-17", title: "Easter Monday" },
    { date: "2028-05-01", title: "Early May bank holiday" },
    { date: "2028-05-29", title: "Spring bank holiday" },
    { date: "2028-08-28", title: "Summer bank holiday" },
    { date: "2028-12-25", title: "Christmas Day" },
    { date: "2028-12-26", title: "Boxing Day" },
];

/** Last date the list covers. Leave booked after this would count bank holidays as leave days. */
export const BANK_HOLIDAYS_KNOWN_UNTIL = "2028-12-31";

export const isBankHoliday = (date: Date): boolean => {
    const dateString = date.toISOString().split('T')[0];
    return UK_BANK_HOLIDAYS_2025_2026.some(h => h.date === dateString);
};
