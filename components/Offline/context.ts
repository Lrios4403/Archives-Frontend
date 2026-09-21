'use client';

import { createContext } from "react";
import { WarcFilesState, WarcRecordContextType, WarcViewState } from "./types";

/**
 * Three contexts, not one, because the three change at wildly different rates.
 *
 * There used to be a single snapshot carrying the records, the current view and
 * the file selection together, rebuilt on every store flush — and a flush
 * happens once per animation frame for as long as a parse is running. Every
 * consumer re-rendered sixty times a second no matter which part it read, which
 * quietly undid the keyed tree listeners, the row memo and the progress
 * coalescing, all of which exist to keep a parse cheap.
 *
 * Split, each consumer pays only for what it actually reads.
 */

/**
 * The stable half: the record index, the tree, and every action.
 *
 * Its identity NEVER changes, so subscribing to it can never cause a render.
 * Components that want to be told about records subscribe to `treeVersions`
 * instead, keyed by the one node they care about.
 */
export const WarcRecordContext = createContext<WarcRecordContextType | undefined>(undefined);

/** What the frame is showing. Changes on navigation only. */
export const WarcViewContext = createContext<WarcViewState | undefined>(undefined);

/** The selected files. Changes when the selection changes, not while parsing. */
export const WarcFilesContext = createContext<WarcFilesState | undefined>(undefined);
