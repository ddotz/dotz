export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const list = (value: unknown): unknown[] | undefined => (Array.isArray(value) ? (value as unknown[]) : undefined);
