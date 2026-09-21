'use client';

/**
 * Storing records and file handles: the plain mutations, with no notification.
 *
 * Telling React about them is the store's job (store.ts), which wraps each of
 * these and marks itself dirty afterwards.
 */

import { WarcFileHande, WarcRecord, WarcRecordEntries, WarcRecordTreeNode } from "./types";
import { bumpTreeVersion, pushRecordIntoTree, RECORD_COUNT_KEY } from "./tree";

/**
 * An empty record store.
 *
 * A factory rather than an object literal at each site, because there were five
 * copies of that literal — the store and four test harnesses — and adding a
 * field meant finding all of them. The one that got missed failed at runtime,
 * not at the type level, because the harnesses build it in plain JavaScript.
 */
export const createRecordEntries = (): WarcRecordEntries => ({
    records: [],
    recordCount: 0,
    responseCount: 0,
    recordsUrlMap: new Map<string, WarcRecord[]>(),
    recordsDigestMap: new Map<string, WarcRecord[]>(),
    seenRecordIds: new Set<string>(),
    untreedRecords: [],
    recordTree: [],
    recordTreeIndex: new Map<string, WarcRecordTreeNode>(),
    normalTree: [],
    normalTreeIndex: new Map<string, WarcRecordTreeNode>(),
    segments: new Map<string, WarcRecordTreeNode[]>(),
    normalSegments: new Map<string, WarcRecordTreeNode[]>(),
    contentTypes: new Map<string, Set<WarcRecordTreeNode>>(),
    normalContentTypes: new Map<string, Set<WarcRecordTreeNode>>(),
    treeVersions: new Map<string, number>(),
    dirtyTreeUrls: new Set<string>(),
});

/**
 * Store a record and put it wherever it belongs.
 *
 * `records` takes everything, unconditionally — that list is the archive as
 * parsed, and nothing is dropped from it for being awkward. The url group and
 * the tree are both indexes over it, and a record only joins an index it
 * actually has a key for.
 */
export const pushRecord = (record: WarcRecord, recordsRef: WarcRecordEntries): boolean => {
    // Already stored. Re-parsing the same file — which is one accidental click
    // on "Process locally" — hands us every record a second time, and without
    // this each one joined its url group and its tree node again.
    //
    // Checked BEFORE anything is mutated, so a rejected record leaves no trace
    // in the flat list, the url map or the tree.
    if (recordsRef.seenRecordIds.has(record.customId)) return false;

    recordsRef.seenRecordIds.add(record.customId);
    recordsRef.records.push(record);

    // Running totals, so anything showing a count reads two numbers instead of
    // filtering the whole list. See WarcRecordEntries.recordCount.
    recordsRef.recordCount++;
    if (record.type === 'response') recordsRef.responseCount++;

    // Wake the totals. One keyed listener rather than the store's global emit,
    // which is what the split store exists to avoid — see RECORD_COUNT_KEY.
    bumpTreeVersion(recordsRef, RECORD_COUNT_KEY);

    // The revisit index — see WarcRecordEntries.recordsDigestMap.
    //
    // Donors only. A record earns a place here by HOLDING bytes, so the condition
    // is `payload`, not `type`: that admits any record with a body and excludes
    // every revisit, which is what stops a revisit resolving to another revisit and
    // makes the lookup a single step rather than a walk.
    //
    // Mutated in place for the same two reasons the url group is, the second being
    // the one that bites: replacing the array orphans every reference to it.
    if (record.digest && record.payload) {
        let sharing = recordsRef.recordsDigestMap.get(record.digest);

        if (!sharing) {
            sharing = [];
            recordsRef.recordsDigestMap.set(record.digest, sharing);
        }

        sharing.push(record);
    }

    // Guarded by the url check because without it every url-less record formed
    // one group under '', and the reconciliation below then stamped a September
    // warcinfo with October's date — an unrelated file's, from a "group" whose
    // members have nothing to do with each other.
    if (record.url) {
        // Fetched once and MUTATED, not rebuilt with [...group, record] and set
        // back. Two reasons, and the second is the one that bites:
        //
        //   The copy was O(group) per insert, so a url captured n times cost
        //   O(n²) overall. Small in practice — groups across the archives on hand
        //   run a median of 2 and a max of 40 — but paid for nothing.
        //
        //   More importantly, replacing the array orphans every reference to it.
        //   Anything holding the result of recordsUrlMap.get(url) would keep an
        //   array that silently stops growing. That is the same hazard that makes
        //   recordTree an alias rather than a copy, and it is invisible until
        //   something reads the map and wonders where its records went.
        //
        // Note that `map.set(url, group.push(record))` cannot work: Array.push
        // returns the new LENGTH, so that stores a number where the array goes.
        let group = recordsRef.recordsUrlMap.get(record.url);

        if (!group) {
            group = [];
            recordsRef.recordsUrlMap.set(record.url, group);
        }

        // lastArchived is "newest capture of this url" — the same value on every
        // record sharing it, so it is a property of the GROUP that happens to be
        // stored per record.
        //
        // Read before the push, and read off group[0] rather than scanned for:
        // every existing member already agrees on this value, so member zero IS
        // the current answer. The old code ran a reduce over the whole group to
        // recompute a maximum it was already holding.
        const newest = group.length > 0 ? group[0]!.lastArchived : null;

        group.push(record);

        if (newest === null) {
            // First member. It IS the answer, and there is nobody to tell.
            record.lastArchived = record.dateArchived;
        } else if (record.dateArchived > newest) {
            /*
             * A new newest, so every earlier member's answer changed with it.
             *
             * This branch was documented as running "only when the max moves", as
             * though that were rare. It is not: records arrive in crawl order, so
             * each new capture of a url is almost always newer than the last and
             * this runs on nearly every insert — making the per-url cost O(n²) in
             * its capture count, not O(n).
             *
             * Left as a loop anyway, and deliberately. The groups are small — a
             * median of 2 and a max of 40 across the archives on hand, so the worst
             * url on record costs ~1,600 writes over an entire parse — and the
             * alternative is moving `lastArchived` off the record and onto the
             * group, which every reader of that field would have to be taught
             * about. Not worth it for a number this size; worth knowing before
             * anyone loads an archive with thousands of captures of one url, where
             * this is the first thing that would show up in a profile.
             */
            for (const entry of group) entry.lastArchived = record.dateArchived;
        } else {
            // The group's answer is unchanged; only the newcomer needs telling.
            record.lastArchived = newest;
        }
    }

    // Kept, just not hung off a node. See WarcRecordEntries.untreedRecords.
    if (!pushRecordIntoTree(record, recordsRef)) {
        recordsRef.untreedRecords.push(record);
    }

    return true;
}

export const pushFileHandle = (handle: WarcFileHande, handlesRef:WarcFileHande[]) => {
    handlesRef.push(handle);
}

export const setFileHandles = (handles: WarcFileHande[], handlesRef:WarcFileHande[]) => {
    handlesRef.length = 0;
    handlesRef.push(...handles);
}
