import { createHandoffResume } from "../harness/restart/handoff-resume.ts";
import type { HandoffResumeApi } from "../harness/restart/handoff-resume.ts";

/** Resumes a session at once after the owner's manual `/handoff`, which omp otherwise leaves idle. */
export default function registerHandoffResume(pi: HandoffResumeApi): void {
	createHandoffResume(pi);
}
