import { dryRun } from "./doctor.ts";

const { text, result } = await dryRun();
console.log(process.argv.includes("--json") ? JSON.stringify(result) : text);
