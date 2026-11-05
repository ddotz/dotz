export type Out = { lines: string[]; code: number };

export const OK = 0;
export const FAILED = 1;
export const BLOCKED = 3;

export const done = (...lines: string[]): Out => ({ lines, code: OK });
export const failed = (...lines: string[]): Out => ({ lines, code: FAILED });
export const blocked = (...lines: string[]): Out => ({ lines, code: BLOCKED });
