// Native proof-only transform: substitute a scratch file at the real module ID.
import { readFileSync } from "node:fs";

export function proofFault() {
  return {
    name: "proof:scratch-fault",
    enforce: "pre",
    transform(_code, id) {
      const target = process.env.BOARD_PROOF_FAULT_FILE;
      if (target && id.split("?")[0].endsWith("/" + target)) {
        return { code: readFileSync(process.env.BOARD_PROOF_FAULT_COPY, "utf8"), map: null };
      }
    },
  };
}
