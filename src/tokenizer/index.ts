/** Factory that builds a token counter for the mode selected in the options. */

import type { GuardOptions } from "../options.js";
import type { TokenCounter } from "../types.js";
import { createLocalCounter } from "./local.js";
import { createDelegateCounter } from "./delegate.js";

export function createCounter(options: GuardOptions): TokenCounter {
  if (options.mode === "delegate") {
    if (!options.backend) {
      throw new Error("mode=delegate requires the backend option (llama-server base URL)");
    }
    return createDelegateCounter(options.backend);
  }

  if (!options.tokenizerPath) {
    throw new Error(
      "mode=local requires the tokenizerPath option (path to the model's tokenizer.json). " +
        "It usually sits next to the GGUF file in the LM Studio model folder.",
    );
  }
  return createLocalCounter({
    tokenizerPath: options.tokenizerPath,
    ...(options.tokenizerConfigPath !== undefined ? { tokenizerConfigPath: options.tokenizerConfigPath } : {}),
  });
}
