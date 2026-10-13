/**
 * Local token counting via @huggingface/tokenizers (pure JS, no native
 * dependencies and no onnxruntime).
 *
 * The files are taken from the model folder (LM Studio places tokenizer.json
 * next to the GGUF file).
 */

import { readFileSync } from "node:fs";
import { Tokenizer } from "@huggingface/tokenizers";
import type { TokenCounter } from "../types.js";

export interface LocalCounterPaths {
  tokenizerPath: string;
  tokenizerConfigPath?: string;
}

export function createLocalCounter(paths: LocalCounterPaths): TokenCounter {
  const tokenizerJson = JSON.parse(readFileSync(paths.tokenizerPath, "utf8")) as Record<string, unknown>;
  const tokenizerConfig =
    paths.tokenizerConfigPath !== undefined
      ? (JSON.parse(readFileSync(paths.tokenizerConfigPath, "utf8")) as Record<string, unknown>)
      : ({} as Record<string, unknown>);

  const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);

  return {
    kind: "local",
    count(text: string): number {
      if (text.length === 0) return 0;
      return tokenizer.encode(text).ids.length;
    },
    describe(): string {
      return `local(${paths.tokenizerPath})`;
    },
  };
}
