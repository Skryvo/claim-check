import { escapeData, run } from "./run.js";

run().then(
  (code) => {
    process.exitCode = code;
  },
  (error: Error) => {
    process.stdout.write(`::error::${escapeData(error.message)}\n`);
    process.exitCode = 1;
  },
);
