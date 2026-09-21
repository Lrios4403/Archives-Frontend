/*
 * The timeline's bucketing rule, in a module with no "use client" on it.
 *
 * It lived in TimelineWidget.tsx for one commit and that was a server error, not
 * a style problem: a "use client" file's exports are CLIENT REFERENCES, so a
 * server component may render them but may not call them. SiteResults is a
 * server component and calls distinctDays to decide whether to render the
 * widget at all, which failed the whole route with "A server error occurred".
 *
 * So the rule lives here, importable from either side, and TimelineWidget
 * imports it too — the point was always that one definition decides both how
 * many bars there are and whether they are worth drawing.
 */

const pad2 = (value: number) => (value < 10 ? `0${value}` : String(value))

/**
 * The local-day key a record is bucketed under. The x-axis is made of these.
 *
 * Local rather than UTC, matching what the chart displays: a capture at 02:34Z
 * belongs to the reader's day, and keying off toISOString() would file it under
 * the previous one and put the bar under the wrong label.
 */
export const dayKeyOf = (dateArchived: string | number | Date): string => {
    const at = new Date(dateArchived)

    return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`
}

/**
 * How many bars `records` would produce.
 *
 * A timeline earns its 195px when there is more than one. A chart's axis is
 * days, so any number of captures from a single day is one column, and the panel
 * then reads "1 days · N records · Peak: N" above a list that already said it.
 * Across this archive's 13,830 urls, 12,716 have one capture, 1,073 have several
 * on one day, and 41 span more than one.
 */
export const distinctDays = (records: readonly { dateArchived: string }[]): number => {
    const seen = new Set<string>()

    for (const record of records) seen.add(dayKeyOf(record.dateArchived))

    return seen.size
}
