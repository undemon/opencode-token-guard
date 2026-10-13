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
  readonly kind: string;
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

/** Text slots of a message that are available for editing. */
export function textSlots(message: MessageLike): TextSlot[] {
  const slots: TextSlot[] = [];
  const content = message.content;
  if (Array.isArray(content)) {
    content.forEach((part) => {
      if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
        slots.push({
          kind: "text",
          read: () => part.text ?? "",
          write: (next: string) => {
            part.text = next;
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
