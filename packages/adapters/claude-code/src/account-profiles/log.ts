/**
 * Diagnostics for saved Claude sign-ins, written to the Host Runtime's stderr and so to its
 * bounded log file. Entries name profiles by id only: diagnostic bundles leave the machine, so
 * emails, tokens, authorization codes and links never appear here.
 */
export type ClaudeAccountLogValue = string | number | boolean | null;
export type ClaudeAccountLog = (
  event: string,
  fields?: Record<string, ClaudeAccountLogValue | undefined>,
) => void;

export const writeClaudeAccountLog: ClaudeAccountLog = (event, fields = {}) => {
  const entry: Record<string, ClaudeAccountLogValue> = { event };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) entry[key] = value;
  }
  try {
    process.stderr.write(`[claude-accounts] ${JSON.stringify(entry)}\n`);
  } catch {
    // A closed stderr must not break account handling.
  }
};
