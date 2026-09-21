'use client';

import type { CSSProperties } from "react";
import { useSyncExternalStore } from "react";
import { viewProgressStore, type ViewStage } from "./view";
import shared from "./Offline.module.css";
import s from "./viewProgressOverlay.module.css";

/** What each stage means to a reader, rather than to the code. */
const stageLabels: Record<ViewStage, string> = {
    'reading': 'Reading from the archive',
    'resolving': 'Collecting what the page needs',
    'rewriting': 'Rebuilding the page',
    // Never displayed: `done` clears the report rather than becoming one. Here
    // so the map is total and a new stage cannot be added without a label.
    'done': 'Done',
};

/** Trim a url to something readable, keeping the end where the filename is. */
const shortUrl = (url: string) => {
    if (url.length <= 52) return url;
    return `${url.slice(0, 22)}…${url.slice(-28)}`;
};

/**
 * What the viewer is doing, over the frame, while it does it.
 *
 * Rebuilding a page is not instant: the document comes out of the archive, and
 * then every reference in it is chased, and those have references of their own.
 * On a page with two hundred subresources that is seconds of a blank frame, and
 * a reader cannot tell working from hung. This is the difference.
 *
 * Subscribes to the progress store DIRECTLY rather than reading the record
 * context, for the same reason the notice badge does: this updates once per
 * resolved subresource, and routing that through the context snapshot would
 * re-render every consumer of the store hundreds of times per page load.
 */
export default function WarcOfflineViewProgress() {
    const progress = useSyncExternalStore(
        viewProgressStore.subscribe,
        viewProgressStore.getSnapshot,
        viewProgressStore.getServerSnapshot,
    );

    // Non-null IS "loading". There is no second boolean to fall out of step.
    if (!progress) return null;

    const { stage, url, resolved, total } = progress;

    // The denominator grows as the walk descends — a stylesheet's own images are
    // not known until it has been read — so this is a hint, not a measurement.
    // Clamped because a total that has just grown can briefly trail the count.
    const ratio = total > 0 ? Math.min(100, Math.round((resolved / total) * 100)) : 0;

    return (
        <div role="status" aria-live="polite" className={s.overlay}>
            <div className={s.card}>
                <div className={s.head}>
                    <p className={s.stage}>{stageLabels[stage] ?? stage}</p>
                    {total > 0 && (
                        <p className={s.count}>
                            {resolved} / {total}
                        </p>
                    )}
                </div>

                <p className={`${shared.metaDim} ${shared.mono} ${shared.truncate} ${s.url}`} title={url}>
                    {shortUrl(url)}
                </p>

                <div
                    className={`${shared.progressTrack} ${s.bar}`}
                    role="progressbar"
                    aria-valuenow={ratio}
                    aria-valuemin={0}
                    aria-valuemax={100}
                >
                    <div
                        className={shared.progressFill}
                        style={{ '--progress': ratio } as CSSProperties}
                    />
                </div>
            </div>
        </div>
    );
}
