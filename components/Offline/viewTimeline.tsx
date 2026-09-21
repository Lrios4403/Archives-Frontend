'use client';

import { useContext, useMemo } from "react";
import { WarcRecordContext, WarcViewContext } from "./context";
import { WarcOfflineCaptureList, timelineResponses } from "./recordListingTimeline";
import { focusArchiveViewer } from "./viewerFocus";
import shared from "./Offline.module.css";
import surfaces from "../shared/primitives.module.css";

/**
 * Every capture of the page currently being viewed.
 *
 * This is the thing a web archive does that a browser cannot: the address in the
 * frame header says WHERE the reader is, and this says WHEN — and lets them move
 * along that axis. All of it was already in recordsUrlMap; before this there was
 * simply no way to reach it from the viewer, only by finding the page again in
 * the tree.
 *
 * The same panel the tree opens, deliberately: WarcOfflineCaptureList is shared,
 * so the chart, the rows, the status colours and the View/Download buttons are
 * one implementation rather than two that resemble each other.
 *
 * Keyed off the RECORD on screen rather than a url string, because several
 * captures share one address and the active marker has to pick the right one.
 */
export default function WarcOfflineViewTimeline() {
    const context = useContext(WarcRecordContext);
    const record = useContext(WarcViewContext)?.viewingRecord;

    // The raw url group, not the tree node: a tree node is keyed by path segment
    // and can hold several urls, while this is specifically "other captures of
    // THIS address".
    const group = record ? context?.recordEntries.recordsUrlMap.get(record.url) : undefined;

    /**
     * Filtered and sorted once per change, not once per render.
     *
     * It used to re-filter and re-sort on every store flush — sixty times a
     * second during a parse — while the group was simultaneously being pushed
     * into. The context split means this component now renders only when the
     * VIEW changes, but the memo stays: the identity it returns feeds the memos
     * inside WarcOfflineCaptureList, which feed TimelineWidget's own.
     *
     * `group.length` is a dependency because the group is MUTATED IN PLACE: it
     * grows as captures arrive without its identity ever changing, so the array
     * alone would never signal that there is more to show.
     */
    const responses = useMemo(
        () => (group ? timelineResponses(group) : []),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [group, group?.length],
    );

    // After the hooks, never before: an early return above them would change the
    // hook order between renders.
    if (!context || !record || responses.length === 0) return null;

    return (
        <section
            className={surfaces.card}
            aria-label={`Captures of ${record.url}`}
        >
            <div className={shared.panelHeader}>
                <div className={shared.spacer}>
                    <p className={shared.urlLine} title={record.url}>{record.url}</p>
                    <p className={shared.meta}>
                        {responses.length} capture{responses.length === 1 ? '' : 's'} of the page you are viewing
                    </p>
                </div>
            </div>

            <WarcOfflineCaptureList
                records={responses}
                anchor={record.url}
                activeRecordId={record.customId}
                onView={(picked) => {
                    if (picked.customId === record.customId) return;

                    // Before the rebuild, not after it — this panel sits below
                    // the frame and a long capture list pushes it off-screen.
                    focusArchiveViewer();

                    // Through showBlob like any other navigation, so switching
                    // captures joins the history trail — Back returns to the one
                    // you were reading rather than skipping past it.
                    void context.viewArchivedRecord?.(picked, context.recordEntries).then(outcome => {
                        if (outcome.ok) context.showBlob?.(outcome);
                        else context.showViewFailure?.(outcome);
                    });
                }}
            />
        </section>
    );
}
