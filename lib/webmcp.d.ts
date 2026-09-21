/*
 * Minimal ambient types for the WebMCP Imperative API.
 *
 * Declared here rather than depending on the official `webmcp-types` package,
 * because adding a dependency means package.json and the lockfile have to stay
 * in step with what the VPS image installs at build time, and this is a handful
 * of interfaces for an API that is still an origin trial. Swap to the package if
 * WebMCP ships — it is types-only, so the change is an import and a delete.
 *
 * Kept faithful to webmcp-types@0.1.9 (published 2026-09-17), which is the
 * authority on the shape. Two things in circulation are WRONG and worth naming,
 * because both appear in blog posts and both fail silently:
 *
 *   * the callback is `execute`, NOT `handler`. `execute` is required; a tool
 *     registered with `handler` has no execute and does not work.
 *   * `execute` returns a value that is stringified — `executeTool` is typed
 *     `Promise<string>`. It does NOT take the `{ content: [{ type: "text" }] }`
 *     envelope, and there is no `isError` field. That envelope belongs to
 *     server-side MCP, a different protocol. Return a plain string; report
 *     failures as a sentence the agent can act on.
 */

declare global {
    namespace WebMCP {
        interface ToolExecuteCallbackOptions {
            /** Fires when the agent or the user cancels this execution. Thread it into fetch. */
            signal: AbortSignal;
        }

        interface ToolAnnotations {
            /** Reads only, changes nothing. Lets an agent call it without confirmation. */
            readOnlyHint?: boolean;
            /**
             * The output contains data this page did not author.
             *
             * Load-bearing for an archive: every byte returned from a capture was
             * written by whoever ran the site being archived. This is what tells
             * the agent to treat the payload as data rather than as instructions.
             */
            untrustedContentHint?: boolean;
            /** Significant, real-world or irreversible. Browsers may force a confirmation. */
            consequentialHint?: boolean;
            /** For developer tooling rather than end users. */
            debugging?: boolean;
        }

        interface ModelContextTool {
            /** 1-128 chars, ASCII alphanumeric plus `_`, `-`, `.`. */
            name: string;
            title?: string;
            description: string;
            inputSchema?: object;
            execute: (
                input: Record<string, never> | any,
                options: ToolExecuteCallbackOptions,
            ) => unknown | Promise<unknown>;
            annotations?: ToolAnnotations;
        }

        interface RegisterToolOptions {
            /** Abort to unregister the tool. */
            signal?: AbortSignal;
            /** Origins allowed to see and call this tool. Secure origins only. */
            exposedTo?: string[];
        }

        interface RegisteredTool {
            name: string;
            title: string;
            description: string;
            inputSchema?: object;
            window: Window;
            origin: string;
            annotations?: ToolAnnotations;
        }

        interface ModelContext extends EventTarget {
            registerTool(tool: ModelContextTool, options?: RegisterToolOptions): Promise<void>;
            getTools(options?: { fromOrigins?: string[] }): Promise<RegisteredTool[]>;
            executeTool(
                tool: RegisteredTool,
                input?: object,
                options?: { signal?: AbortSignal },
            ): Promise<string>;
        }
    }

    interface Document {
        /** Undefined unless the browser has WebMCP enabled. Always feature-detect. */
        readonly modelContext?: WebMCP.ModelContext;
    }
}

export {};
