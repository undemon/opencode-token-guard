/**
 * Text extraction from request parts and access to editable text slots.
 */

export interface PartLike {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  result?: unknown;
  content?: unknown;
  value?: unknown;
  [key: string]: unknown;
}

export interface MessageLike {
  role?: string;
  content?: PartLike[] | string;
  text?: string;
  [key: string]: unknown;
}

/** An editable text slot inside a message. */
export interface TextSlot {
  read(): string;
  write(next: string): void;
  /** Part type if the slot points to a part (otherwise "message"). */
  readonly kind: "text" | "message" | "tool-result";
}

function safeJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/** Text of a single request part. */
export function partText(part: unknown): string {
  if (typeof part === "string") return part;
  if (part === null || typeof part !== "object") return "";
  const p = part as PartLike;
  switch (p.type) {
    case "text":
    case "reasoning":
      return typeof p.text === "string" ? p.text : "";
    case "tool-call":
      return `[Assistant tool call]: ${String(p.name ?? "")}(${safeJson(p.input)})`;
    case "tool-result": {
      const label = p.result && typeof p.result === "object" && (p.result as PartLike).type === "error" ? "Tool error" : "Tool result";
      return `[${label}]: ${safeJson(p.result ?? p.value ?? p.content)}`;
    }
    case "media":
      return "[media]";
    case "compaction":
      return typeof p.text === "string" ? p.text : "";
    default:
      return typeof p.text === "string" ? p.text : "";
  }
}

/** Full text of a message. */
export function messageText(message: MessageLike): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(partText).join("\n");
  if (typeof message.text === "string") return message.text;
  return "";
}

/**
 * Replaces the payload of a tool-result part with `next`.
 *
 * The part shape is kept (the discriminator and the result container), only the
 * value is swapped for a single text item, so the request stays valid for the
 * provider adapters. Handles both the assembled-request form (`result.value`)
 * and the looser `value`/`content` fallbacks.
 */
export function writeToolResult(part: PartLike, next: string): void {
  const replacement = (): { type: "text"; text: string }[] => [{ type: "text", text: next }];
  const result = part.result;
  if (result !== null && typeof result === "object") {
    const container = result as PartLike;
    container.value = Array.isArray(container.value) ? replacement() : next;
    return;
  }
  if (part.value !== undefined) {
    part.value = Array.isArray(part.value) ? replacement() : next;
    return;
  }
  if (part.content !== undefined) {
    part.content = Array.isArray(part.content) ? replacement() : next;
    return;
  }
  part.result = { type: "content", value: replacement() };
}

/**
 * The output text a `tool-result` part carries, without its rendered `[Tool
 * result]: ` prefix and without the JSON envelope around it. This is what the
 * model actually reads, so it is what must be measured and shortened.
 */
export function toolResultText(part: PartLike): string {
  const result = part.result;
  const container = result !== null && typeof result === "object" ? (result as PartLike) : undefined;
  const value = container?.value ?? part.value ?? part.content;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        item !== null && typeof item === "object" && typeof (item as PartLike).text === "string"
          ? ((item as PartLike).text as string)
          : safeJson(item),
      )
      .join("\n");
  }
  if (value !== undefined) return safeJson(value);
  return safeJson(result);
}

/**
 * An editable slot over tool output. `read`/`write` deal in the payload the
 * model reads (no prefix, no JSON envelope); `render` returns the whole rendered
 * slot, which is what token accounting must use on both sides of an edit.
 */
export interface ResultSlot {
  read(): string;
  write(next: string): void;
  render(): string;
  readonly kind: "tool-result" | "text";
}

/** The result slot behind a part, or undefined when the part holds no tool output. */
export function resultSlotForPart(part: PartLike): ResultSlot | undefined {
  if (part.type === "tool-result") {
    return {
      kind: "tool-result",
      read: () => toolResultText(part),
      write: (next: string) => {
        writeToolResult(part, next);
      },
      render: () => partText(part),
    };
  }
  if (part.type === "text" && typeof part.text === "string") {
    const found = /^\[(Tool result|Tool error)\]: ([\s\S]*)$/.exec(part.text);
    if (!found) return undefined;
    const label = found[1] as string;
    return {
      kind: "text",
      read: () => {
        const current = /^\[(Tool result|Tool error)\]: ([\s\S]*)$/.exec(part.text ?? "");
        return current?.[2] ?? "";
      },
      write: (next: string) => {
        part.text = `[${label}]: ${next}`;
      },
      render: () => part.text ?? "",
    };
  }
  return undefined;
}

/** Result slots of a message, in content order. */
export function resultSlots(message: MessageLike): ResultSlot[] {
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const slots: ResultSlot[] = [];
  for (const part of content) {
    if (part === null || typeof part !== "object") continue;
    const slot = resultSlotForPart(part);
    if (slot) slots.push(slot);
  }
  return slots;
}

/** Text slots of a message that are available for editing. */
export function textSlots(message: MessageLike): TextSlot[] {
  const slots: TextSlot[] = [];
  const content = message.content;
  if (Array.isArray(content)) {
    content.forEach((part) => {
      if (part === null || typeof part !== "object") return;
      if (part.type === "text" && typeof part.text === "string") {
        slots.push({
          kind: "text",
          read: () => part.text ?? "",
          write: (next: string) => {
            part.text = next;
          },
        });
      } else if (part.type === "tool-result") {
        slots.push({
          kind: "tool-result",
          read: () => partText(part),
          write: (next: string) => {
            writeToolResult(part, next);
          },
        });
      }
    });
  } else if (typeof content === "string") {
    slots.push({
      kind: "message",
      read: () => (typeof message.content === "string" ? message.content : ""),
      write: (next: string) => {
        message.content = next;
      },
    });
  } else if (typeof message.text === "string") {
    slots.push({
      kind: "message",
      read: () => (typeof message.text === "string" ? message.text : ""),
      write: (next: string) => {
        message.text = next;
      },
    });
  }
  return slots;
}
