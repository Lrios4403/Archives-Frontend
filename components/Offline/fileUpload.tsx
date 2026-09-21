'use client';

import { useContext, useEffect, useState } from "react";
import { WarcFilesContext, WarcRecordContext } from "./context";
import { WarcFileHande } from "./types";
import WarcOfflineFileListing from "./fileListing";
import Button from "@/components/Button/Button";
import { listContainerArchives, maxSegmentsFor, usefulWorkers } from "./workers";
import shared from "./Offline.module.css";
import s from "./fileUpload.module.css";

/**
 * Hard ceiling on the thread input.
 *
 * Not a performance limit so much as a sanity one: each worker is a real OS
 * thread with its own JS heap and its own copy of the parser bundle, so asking
 * for sixty of them costs memory before it costs anything else.
 */
/**
 * No upper limit. One is still the floor, and a non-number is still one.
 *
 * There was a hard cap of 16, which is the wrong call for a tool whose whole point
 * is chewing through gigabytes on whatever machine you have: a 24-core box was
 * being held to 16, and the cap silently rewrote what you typed rather than telling
 * you it disagreed.
 *
 * Nothing dangerous is unlocked by removing it — `useful` below floors the count at
 * how many SEGMENTS the selected files can be divided into, so asking for 64 threads
 * on a 200 MB archive starts 3. What IS worth saying is when the number exceeds what
 * the hardware can run at once, so the hint below says so instead of the input
 * quietly refusing.
 */
const clampWorkers = (value: number) =>
    Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;

// The File is carried as-is rather than wrapped in a read function. The handle
// gets posted to a parse worker, and structured clone rejects functions with
// DataCloneError — a closure here could never make the trip. File is cloneable,
// so the worker receives it and builds its own reader from it.
const toFileHandle = (file: File): WarcFileHande => ({
    size: file.size,
    parsedOffset: 0,
    name: file.name,
    file,
    stamp: file.lastModified,
});

/**
 * One handle per archive inside a container, or a single handle if it is not one.
 *
 * This is what turns a `.wacz` from one thread's work into N threads' work: the
 * parse pool assigns a worker per HANDLE, so expanding the container here is the
 * whole of the parallelism. Each archive is a Blob slice over the same bytes — no
 * copy, and a `.wacz` is stored rather than deflated, so a slice of it is a
 * readable `.warc.gz` on its own (see backend/parser/wacz.ts).
 *
 * Names are prefixed with the container so the listing says where each archive came
 * from, and so `customId` — `${fileHandle.name}::${url}::${uuid}` — stays unique
 * across the archives of one container.
 */
const toFileHandles = async (file: File): Promise<WarcFileHande[]> => {
    if (!CONTAINER_EXTENSIONS.test(file.name)) return [toFileHandle(file)];

    const archives = await listContainerArchives(file);

    // Not a container after all, or unreadable as one. Parsing it whole still works
    // — the worker sniffs the bytes itself — and reports any real problem where
    // failures are already shown.
    if (archives.length === 0) return [toFileHandle(file)];

    return archives.map(archive => ({
        size: archive.size,
        parsedOffset: 0,
        name: `${file.name} › ${archive.name.split('/').pop() ?? archive.name}`,
        file: file.slice(archive.dataOffset, archive.dataOffset + archive.size),
        stamp: file.lastModified,
    }));
};

/**
 * What the parser can read.
 *
 * `.warc.gz` and `.wacz` used to be rejected here, because mwarc had no gzip
 * stage and a compressed archive failed on its very first header rather than at
 * some later record. That is no longer true: parser/gzip.ts reads a
 * record-compressed `.warc.gz` by translating logical offsets to gzip members,
 * and parser/wacz.ts reads the `.warc.gz` entries out of a `.wacz` without
 * extracting it. See parser/fflate.warc.gz.md.
 *
 * A single `.wacz` becomes SEVERAL archives, all parsed by one worker in
 * sequence — worth knowing when picking a thread count below, since a container
 * counts as one file no matter how many archives it holds.
 *
 * `.wacz.zip` is here because browsers commonly rename a `.wacz` download that
 * way, and the file is a perfectly good container either way.
 */
const ACCEPTED_EXTENSIONS = /\.(warc(\.gz)?|wacz(\.zip)?)$/i;

/**
 * The subset of the above that holds MORE THAN ONE archive.
 *
 * Only used to warn about thread usage, so a name-based test is the right cost:
 * being certain would mean reading each file's zip central directory before the
 * form could render.
 */
const CONTAINER_EXTENSIONS = /\.wacz(\.zip)?$/i;

/**
 * The picker's filter, which is a hint only.
 *
 * Browsers match `accept` against the text after the LAST dot, so ".warc.gz" is
 * not a token any of them understand — hence the bare ".gz". Being broader than
 * ACCEPTED_EXTENSIONS costs nothing: the check below is what actually holds, and
 * the worker sniffs the bytes regardless of what anything is called.
 */
const ACCEPT_HINT = '.warc,.gz,.wacz,.zip';

/** Human-readable, for the rejection message. */
const ACCEPTED_LABEL = '.warc, .warc.gz or .wacz';

const isWarcFile = (file: File) => ACCEPTED_EXTENSIONS.test(file.name);

/**
 * Threads to start by default.
 *
 * Owned here rather than on the context. It used to be `numberOfWorkers` on the
 * store snapshot — a constant 4 that seeded this input and was never written
 * back when the reader changed it, so the store's copy was stale the moment
 * anyone typed. One value, in the one component that starts a parse.
 */
const DEFAULT_WORKERS = 4;

/** Stable, so `files` does not change identity when there is no provider. */
const NO_FILES: WarcFileHande[] = [];

export default function WarcOfflineFileUploadForm({
}) {

    const context = useContext(WarcRecordContext);
    const selection = useContext(WarcFilesContext);

    const [rejected, setRejected] = useState<string[]>([]);

    /** True while a container is being opened to see what archives it holds. */
    const [expanding, setExpanding] = useState(false);

    // The selected handles come from the store, not from local state.
    //
    // They used to be both: a useState array here AND the same handles pushed
    // into the store. The objects were shared so mutations showed up, but the
    // ARRAY was duplicated — so the listing rendered a copy the store could not
    // update, and "Selected Files (n)" could not react to anything the store
    // did. One place owns them now.
    const files = selection?.fileHandles ?? NO_FILES;

    // The form is the only thing that starts a parse, so this lives here and
    // nowhere else.
    const [workers, setWorkers] = useState<number>(DEFAULT_WORKERS);

    // Read after mount, never during render: `navigator` does not exist on the
    // server, and using it for the input's initial value would mean the server
    // and the client disagreed about what to draw. Only ever a hint, so a null
    // here costs nothing.
    const [cores, setCores] = useState<number | null>(null);

    useEffect(() => {
        setCores(typeof navigator === 'undefined' ? null : navigator.hardwareConcurrency ?? null);
    }, []);

    // A worker takes a WHOLE FILE and holds it to the end, so workers beyond the
    // number of files have nothing to pick up. A profile of five files on four
    // workers showed three of them finishing at 7s and idling for the remaining
    // 4.5s while one ground through a 1.6 GB archive — asking for eight would not
    // have helped at all.
    /*
     * Threads that can actually be given work, counting SEGMENTS rather than files.
     *
     * This was `min(workers, files.length)`, which was true before a file could be
     * shared and is the reason segmentation did nothing after it was built: one big
     * archive gave `useful = 1`, so one worker started, so planTasks was asked for
     * one segment, so it produced a whole-file task. The feature was starved by the
     * form, not broken in the parser.
     */
    const useful = usefulWorkers(files, workers);
    const surplus = files.length > 0 && workers > useful;

    /** Files large enough to be split across workers. */
    const splittable = files.filter(file => maxSegmentsFor(file) > 1);

    /**
     * How many of the selected handles came out of a container.
     *
     * A container is expanded into one handle per archive at selection time, so a
     * reader who picked one `.wacz` sees four rows. Worth explaining, because the
     * count no longer matches what they chose in the picker.
     */
    const expanded = files.filter(file => file.name.includes(' › ')).length;

    const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const selected = Array.from(event.target.files ?? []);

        // `accept` below is only a hint — every picker offers an "All Files"
        // escape hatch, so this is the check that actually holds the rule.
        // Rejects are named rather than silently dropped: a short list with no
        // explanation reads as a bug in the uploader.
        setRejected(selected.filter(file => !isWarcFile(file)).map(file => file.name));

        const accepted = selected.filter(isWarcFile);

        // Async because a container has to be opened to learn what is inside it.
        // The picker has already closed by now, so there is nothing to block; the
        // listing simply fills in once the answer arrives, which for a
        // central-directory read is immediate.
        //
        // `files` is captured deliberately: setFileHandles wants the CURRENT list to
        // reconcile against, and any selection that lands while this is in flight
        // would have to have come from a second picker interaction.
        setExpanding(accepted.length > 0);

        Promise.all(accepted.map(toFileHandles))
            .then(groups => {
                if (context?.setFileHandles) {
                    context.setFileHandles(groups.flat(), files);
                }
            })
            .finally(() => setExpanding(false));
    }

    const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (!context?.parseFileHandles || files.length === 0) {
            return;
        }

        // `useful`, not `workers`: spawning threads that can never be handed a
        // file just costs a heap and a bundle each.
        context.parseFileHandles(useful, files, context.recordEntries);
    }

    return <div className={shared.stackWide}>
        <form onSubmit={handleSubmit} className={s.form}>
            <div className={s.field}>
                {/*
                  * "Choose Local Archives", not "Upload Files". The whole point
                  * of this tool is that there is no upload, and the control that
                  * says otherwise is the one a reader looks at while deciding
                  * whether to trust the claim.
                  */}
                <label className={s.label}>
                    Choose Local Archives
                </label>
                <input
                    type="file"
                    multiple // Allows selecting more than one file
                    accept={ACCEPT_HINT}
                    onChange={handleFileChange}
                    className={s.fileInput}
                />

                {rejected.length > 0 && (
                    <p className={s.warning}>
                        {`Skipped ${rejected.length} file${rejected.length === 1 ? '' : 's'} that ${rejected.length === 1 ? 'is' : 'are'} not ${ACCEPTED_LABEL}: ${rejected.join(', ')}`}
                    </p>
                )}
            </div>

            <div className={s.field}>
                <label htmlFor="warc-worker-count" className={s.label}>
                    Parse threads
                </label>
                <input
                    id="warc-worker-count"
                    type="number"
                    min={1}
                    // No `max`. See clampWorkers — the count is floored at the
                    // number of files anyway, so a large number here asks for
                    // something the pool will not actually start.
                    step={1}
                    value={workers}
                    // Still clamped on change rather than trusting `min`, which the
                    // browser only enforces on form validation — pasting -3 or
                    // clearing the field otherwise reaches the store untouched.
                    onChange={(event) => setWorkers(clampWorkers(event.target.valueAsNumber))}
                    aria-describedby="warc-worker-count-hint"
                    className={s.threads}
                />

                <p id="warc-worker-count-hint" className={s.hint}>
                    {cores !== null && `${cores} logical cores available. `}
                    One thread parses one file at a time.
                </p>

                {/*
                  * "a thread cannot split a file with another" was true until
                  * segmentation landed, and is now false — a plain .warc over 128 MB
                  * is cut into 64 MB blocks and shared. What is still true is that
                  * there is a limit, so this says what the limit actually is rather
                  * than asserting the old rule.
                  */}
                {surplus && (
                    <p className={s.warning}>
                        {`Only ${useful} ${useful === 1 ? 'thread' : 'threads'} will start: that is all the`}
                        {` selected ${files.length === 1 ? 'file' : 'files'} can be divided into.`}
                        {` Large plain .warc files are split into 64 MB pieces and shared, but a compressed`}
                        {` or small file is read by one thread.`}
                    </p>
                )}

                {splittable.length > 0 && (
                    <p className={s.hint}>
                        {`${splittable.length === 1 ? 'One file is' : `${splittable.length} files are`} large enough to`}
                        {` split across threads — up to`}
                        {` ${splittable.reduce((most, file) => Math.max(most, maxSegmentsFor(file)), 0)} for the biggest.`}
                        {` Threads that finish early take over part of whatever is still running.`}
                    </p>
                )}

                {/*
                  * Said rather than enforced. There is no cap on the input any
                  * more, and asking for more threads than the machine has cores is
                  * a legitimate thing to try — they will run, just not at once, and
                  * each one holds an inflate window while it waits. Worth knowing;
                  * not worth overruling.
                  */}
                {cores !== null && useful > cores && (
                    <p className={s.warning}>
                        {`${useful} threads on ${cores} cores — more than can run at once. `}
                        {`They will take turns, and each holds its own read buffer while it waits.`}
                    </p>
                )}

                {/*
                  * A container is expanded into one handle per archive at selection
                  * time, so the thread arithmetic above is about ARCHIVES and works
                  * out on its own. Said anyway, because the row count no longer
                  * matches what the reader picked in the file dialog — one .wacz
                  * becomes four rows, and that looks like a bug until it is named.
                  */}
                {expanded > 0 && (
                    <p className={s.hint}>
                        {`${expanded} of these came out of a .wacz container, one row per archive inside it.`}
                        {` They are byte ranges of the same file, not copies, and they parse in parallel —`}
                        {` which is why they are listed separately rather than as the container.`}
                    </p>
                )}

                {expanding && (
                    <p className={s.hint}>Reading container contents…</p>
                )}
            </div>

            <Button type="submit" disabled={files.length === 0} className={s.submit}>
                Process Locally
            </Button>
        </form>

        <WarcOfflineFileListing files={files} revision={selection?.revision ?? 0} />
    </div>
}
