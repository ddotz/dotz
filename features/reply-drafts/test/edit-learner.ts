import { learnSentEdit } from "../lib/flow.ts";

const [id = "", lesson = ""] = process.argv.slice(2);
let calls = 0;
await learnSentEdit(id, { learnCall: () => async () => (calls++, JSON.stringify({ lesson, everywhere: false })) });
console.log(calls);
