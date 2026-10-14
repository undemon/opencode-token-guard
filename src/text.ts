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
