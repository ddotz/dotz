import { type Runner, realRunner } from "./readers.ts";
import { dataDir } from "./store.ts";
import { type Fetcher, realFetch } from "./web.ts";

export type Deps = { run: Runner; fetchText: Fetcher; data: string };

export const realDeps = (): Deps => ({ run: realRunner, fetchText: realFetch, data: dataDir() });
