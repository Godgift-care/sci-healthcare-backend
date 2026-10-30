#!/usr/bin/env node
/** The environment the CLI reads; injectable for tests. */
export type CliEnv = Record<string, string | undefined>;
export type CliOptions = {
    /** Arguments after the program name, i.e. `process.argv.slice(2)`. */
    argv: readonly string[];
    /** Overridable for tests; defaults to the global `fetch`. */
    fetchImpl?: typeof fetch;
    env?: CliEnv;
    stdout?: (chunk: string) => void;
    stderr?: (chunk: string) => void;
};
/** Wrong arguments: the command did not run. Reported with exit code 2. */
export declare class UsageError extends Error {
    constructor(message: string);
}
/** Renders rows as an aligned markdown-free table. */
export declare function renderTable(rows: Record<string, unknown>[]): string;
/**
 * Runs one command line. Returns the process exit code instead of exiting,
 * so tests can drive it in-process.
 */
export declare function runCli(options: CliOptions): Promise<number>;
