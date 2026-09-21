'use client';

/**
 * Downloads in flight, and how the last few ended.
 *
 * A store of its own, not a slice of the view store, because a download outlives
 * the thing that started it. The reader presses Download, then carries on
 * browsing: closing that page, opening another, pressing Back. Every one of those
 * clears or rebuilds the view slice, and none of them should touch a zip being
 * written.
 *
 * Sessions are kept AFTER they finish rather than dropped, because the outcome is
 * the point. A download that failed with "disk full" has nothing left in flight
 * to describe it, and a reader who was looking elsewhere at that moment would
 * otherwise never learn it failed.
 *
 * See backend/parser/download.plan.md for the protocol this mirrors.
 */

import { createListeners } from "./store";
import type { MissingRef } from "./view";

/** Where a download has got to. The last three are terminal. */
export type DownloadStage =
    | 'starting'
    /** Following references out of the page, discovering what has to be written. */
    | 'walking'
    /** Streaming entries into the zip. */
    | 'writing'
    /** Writing the central directory. Short, and the last thing that can fail. */
    | 'finishing'
    | 'done'
    | 'failed'
    | 'cancelled';

const TERMINAL: readonly DownloadStage[] = ['done', 'failed', 'cancelled'];

export const isTerminal = (stage: DownloadStage): boolean => TERMINAL.includes(stage);

/**
 * Why a download stopped, for the ones that stopped badly.
 *
 * The same vocabulary as the worker protocol, so nothing is translated on the way
 * in and a reason the frontend has never heard of still arrives intact rather
 * than being flattened to "failed".
 */
export type DownloadFailure =
    | 'no-payload'
    | 'unreadable'
    | 'decode'
    | 'write-failed'
    | 'quota'
    | 'sink-lost'
    | 'busy'
    | 'no-sink'
    | 'unknown';

/** A non-fatal problem the walk or the write hit. Folded up until asked for. */
export interface DownloadNotice {
    kind: 'missing' | 'entry-failed' | 'path-collision' | 'merged' | 'redirect-stub'
        | 'path-truncated' | 'limit-reached';
    url: string;
    detail?: string;
    /** Present on `missing`, so it can borrow noticeReasonLabels. */
    reason?: MissingRef['reason'];
}

export interface DownloadSession {
    /** The protocol id. Also this card's React key, and its identity everywhere. */
    id: number;

    /** The page being downloaded, for the card's title. */
    url: string;

    /** Where it is being saved, once that is known. */
    name?: string;

    stage: DownloadStage;

    /**
     * Entries written, and entries known about.
     *
     * `discovered` GROWS while walking — the total is not knowable until the walk
     * ends, which is why this is two numbers and not a percentage. See the note
     * on the bar in downloadNotification.tsx.
     */
    entries: number;
    discovered: number;

    bytes: number;

    /** The url being read or written right now, for the subtitle. */
    at?: string;

    notices: DownloadNotice[];

    /** Set only when stage is 'failed'. */
    failure?: {
        reason: DownloadFailure;
        message: string;
        errorName?: string;
        url?: string;
    };

    /** The finished archive, on browsers with no save picker. See the blob sink. */
    blob?: Blob;

    startedAt: Date;
    endedAt?: Date;
}

/**
 * How many finished sessions to keep.
 *
 * Small on purpose. These are cards on screen, not a log — the manifest inside
 * each zip is the log. Twenty would be a stack the height of the window after an
 * afternoon's work.
 */
const MAX_FINISHED = 4;

/** Upper bound per session, for the same reason notices.ts has one. */
const MAX_NOTICES = 200;

export interface WarcDownloadStore {
    subscribe: (listener: () => void) => () => void;
    getSnapshot: () => readonly DownloadSession[];
    getServerSnapshot: () => readonly DownloadSession[];

    /** Open a card for a download that is about to start. */
    start: (id: number, url: string, name?: string) => void;

    /** Progress. Ignored for an id that has already finished — see `live`. */
    progress: (id: number, patch: Partial<Pick<DownloadSession,
        'stage' | 'entries' | 'discovered' | 'bytes' | 'at'>>) => void;

    note: (id: number, notice: DownloadNotice) => void;

    succeed: (id: number, summary: {
        entries: number; bytes: number; name?: string; blob?: Blob;
        notices?: readonly DownloadNotice[];
    }) => void;

    fail: (id: number, failure: NonNullable<DownloadSession['failure']>) => void;
    cancel: (id: number) => void;

    /** Take one card off screen. Does NOT stop anything — see the note on the ✕. */
    dismiss: (id: number) => void;
    clearFinished: () => void;

    /** Whether anything is still running, for the button's disabled state. */
    isBusy: () => boolean;
}

export const createWarcDownloadStore = (): WarcDownloadStore => {
    let sessions: DownloadSession[] = [];

    const { subscribe, emit } = createListeners();

    /**
     * Apply a change to one session, or do nothing.
     *
     * A NEW array every time, which is the point: useSyncExternalStore compares
     * snapshots by identity. The record store gets away with mutating in place
     * only by pairing that with an explicit version counter, and there is no
     * reason to pay that complexity for a list that is never longer than five.
     */
    const patch = (id: number, change: (session: DownloadSession) => DownloadSession | null) => {
        const at = sessions.findIndex(session => session.id === id);
        if (at < 0) return;

        const current = sessions[at];
        if (!current) return;

        const next = change(current);
        if (!next || next === current) return;

        sessions = [...sessions.slice(0, at), next, ...sessions.slice(at + 1)];

        // Trimmed HERE, not only in `start`. A session becomes finished at
        // succeed/fail/cancel, so trimming only when a new one opens meant the
        // cap was always one behind: seven downloads in a row left five cards on
        // screen, and the last one to finish was never counted at all.
        if (isTerminal(next.stage) && !isTerminal(current.stage)) trim();

        emit();
    };

    /** Drop the oldest finished sessions, keeping every live one. */
    const trim = () => {
        const finished = sessions.filter(session => isTerminal(session.stage));
        if (finished.length <= MAX_FINISHED) return;

        const drop = new Set(
            [...finished]
                .sort((a, b) => (a.endedAt?.getTime() ?? 0) - (b.endedAt?.getTime() ?? 0))
                .slice(0, finished.length - MAX_FINISHED)
                .map(session => session.id));

        sessions = sessions.filter(session => !drop.has(session.id));
    };

    /**
     * Terminal states are FINAL.
     *
     * A cancelled download's messages keep arriving for a moment after the store
     * has moved on — the worker is mid-`add()` when the cancel lands, and whatever
     * was already in flight still gets posted. Without this a `downloadProgress`
     * that overtook the `downloadCancelled` would flip a cancelled card back to
     * "writing" and strand it there, because nothing else is coming. Same class of
     * bug as the one `latestViewId` exists to stop.
     */
    const live = (session: DownloadSession) => isTerminal(session.stage) ? null : session;

    return {
        subscribe,
        getSnapshot: () => sessions,
        getServerSnapshot: () => EMPTY,

        isBusy: () => sessions.some(session => !isTerminal(session.stage)),

        start: (id, url, name) => {
            // Replaced rather than appended, so a retry under a reused id cannot
            // leave two cards claiming to be the same download.
            sessions = [
                ...sessions.filter(session => session.id !== id),
                {
                    id, url, name,
                    stage: 'starting',
                    entries: 0, discovered: 0, bytes: 0,
                    notices: [],
                    startedAt: new Date(),
                },
            ];

            trim();
            emit();
        },

        progress: (id, change) => patch(id, session => {
            const next = live(session);
            if (!next) return null;

            // Guarded because the same values arrive repeatedly: the worker
            // throttles on whole-percent change, but a stage that repeats its last
            // url still posts. Returning a new object regardless would re-render
            // every card for nothing.
            const moved = (['stage', 'entries', 'discovered', 'bytes', 'at'] as const)
                .some(key => change[key] !== undefined && change[key] !== next[key]);

            return moved ? { ...next, ...change } : null;
        }),

        note: (id, notice) => patch(id, session =>
            session.notices.length >= MAX_NOTICES
                ? null
                : { ...session, notices: [...session.notices, notice] }),

        succeed: (id, summary) => patch(id, session => ({
            ...session,
            stage: 'done',
            entries: summary.entries,
            discovered: summary.entries,
            bytes: summary.bytes,
            name: summary.name ?? session.name,
            blob: summary.blob,
            // The worker's full list wins over whatever arrived one at a time:
            // notices are throttled on the way over and a few can be dropped.
            notices: summary.notices ? [...summary.notices].slice(0, MAX_NOTICES) : session.notices,
            at: undefined,
            endedAt: new Date(),
        })),

        // NOT guarded by live(): a fatal that arrives after a cancel is still the
        // truer account of what happened to the file.
        fail: (id, failure) => patch(id, session => ({
            ...session, stage: 'failed', failure, at: undefined, endedAt: new Date(),
        })),

        cancel: (id) => patch(id, session => live(session) && {
            ...session, stage: 'cancelled', at: undefined, endedAt: new Date(),
        }),

        dismiss: (id) => {
            const before = sessions.length;
            sessions = sessions.filter(session => session.id !== id);
            if (sessions.length !== before) emit();
        },

        clearFinished: () => {
            const before = sessions.length;
            sessions = sessions.filter(session => !isTerminal(session.stage));
            if (sessions.length !== before) emit();
        },
    };
};

/** What each stage says to a reader, rather than to the code. */
export const downloadStageLabels: Record<DownloadStage, string> = {
    starting: 'Starting',
    walking: 'Finding resources',
    writing: 'Writing files',
    finishing: 'Finishing the archive',
    done: 'Saved',
    failed: 'Failed',
    cancelled: 'Cancelled',
};

/**
 * What each failure means, in words that say what happened.
 *
 * `write-failed` is not a message. Every one of these has to survive being read
 * by someone who did not write the worker, at the moment an hour's browsing did
 * not get saved.
 */
export const downloadFailureLabels: Record<DownloadFailure, string> = {
    'no-payload': 'That capture stored no page, so there is nothing to save',
    'unreadable': 'The archive file could not be read',
    'decode': 'That capture could not be turned into a page',
    'write-failed': 'The file could not be written',
    'quota': 'There is not enough space on the disk',
    'sink-lost': 'The file being written was moved, deleted, or disconnected',
    'busy': 'Another download is already running',
    'no-sink': 'This browser cannot save a file directly',
    'unknown': 'The download stopped unexpectedly',
};

/** What each non-fatal notice means. */
export const downloadNoticeLabels: Record<DownloadNotice['kind'], string> = {
    'missing': 'Not in the archive',
    'entry-failed': 'Could not be read, and was left out',
    'path-collision': 'Renamed to avoid a clash',
    'merged': 'Saved once, under two addresses',
    'redirect-stub': 'A redirect, saved with a link to where it goes',
    'path-truncated': 'Name shortened to fit',
    'limit-reached': 'The download hit its size limit and stopped early',
};

// Stable identity, or useSyncExternalStore sees a new snapshot on every server
// render and loops.
const EMPTY: readonly DownloadSession[] = [];
