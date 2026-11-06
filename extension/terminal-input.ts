// Dotz mode's terminal: which typed lines this terminal keeps. A "!" shell line and a "/word" line are the harness's: omp runs this
// input hook before its built-in commands and lists them nowhere, so a typo stays here too and gets the harness's own answer.
// A first word shaped like no command (OmO's unknown-command.js test), such as a path, is a message for the gateway.
export const staysInTerminal = (text: string): boolean => text.startsWith("!") || /^\/[A-Za-z][A-Za-z0-9:_-]*$/.test(text.split(/\s/, 1)[0]!);
