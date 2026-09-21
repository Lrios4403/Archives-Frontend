/**
 * Formatting shared by the offline components.
 *
 * Small on purpose. What lives here is anything that had started to exist in more
 * than one file with slightly different behaviour — a divergence nobody notices
 * until two panels describing the same record disagree about its size.
 */

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * A byte count as a reader wants to see it: `30.2 KB`.
 *
 * Bytes are shown whole — "512 B", never "512.0 B" — because a fractional byte is
 * not a thing, and every larger unit gets one decimal, which is the smallest
 * precision that still distinguishes 1.2 MB from 1.9 MB.
 *
 * Undefined rather than zero for a missing count. A record whose size was never
 * recorded and a record that is genuinely empty are different facts, and the
 * caller is the only one that knows which one it wants to show.
 */
export const formatBytes = (bytes?: number | null): string | undefined => {
    if (bytes === undefined || bytes === null || !Number.isFinite(bytes) || bytes < 0) {
        return undefined;
    }

    const exponent = bytes === 0
        ? 0
        : Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), SIZE_UNITS.length - 1);

    const value = bytes / Math.pow(1024, exponent);

    return `${exponent === 0 ? value : value.toFixed(1)} ${SIZE_UNITS[exponent]}`;
};

/**
 * Which capture this is, in the space a header line has for it.
 *
 * The record's own id, not the whole customId. customId is `file::url::uuid`, and
 * the file and the url are already on the line beside it — so quoting all three
 * spends a hundred and forty characters to add one distinguishing value, and the
 * url gets squeezed out to make room for a repeat of itself.
 *
 * The uuid is the part that differs between two captures of the same address,
 * which is the whole reason this is on screen. The full customId belongs in the
 * tooltip, where the file name is worth having.
 */
export const displayRecordId = (record?: { uuid?: string; customId?: string } | null): string => {
    if (!record) return '';

    return record.uuid || record.customId || '';
};

/**
 * The size to SHOW for a record's body.
 *
 * `payload.size` is the byte range on disk, which for a chunked response includes
 * the chunk-size lines and their CRLFs — so quoting it would overstate a chunked
 * page by however much framing it carries. `fullSize` is the decoded length, and
 * it is what the reader is actually looking at.
 *
 * Falls back to `size` when the parser ran without `returnFullSize`, since for a
 * non-chunked body the two are equal anyway and being off on chunked ones beats
 * showing nothing at all.
 */
export const payloadSize = (
    payload?: { size: number; fullSize?: number } | null,
): number | undefined => {
    if (!payload) return undefined;

    return payload.fullSize ?? payload.size;
};
