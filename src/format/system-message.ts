import type { AgentMessage } from "../core/streaming/types.ts";
import { extractTextContent } from "../core/text.ts";

export function formatSystemMessage(
  message: Extract<AgentMessage, { role: "system" }>,
): string {
  const parts: string[] = [];
  const text = extractTextContent(message.content);
  if (text.trim() !== "") parts.push(text);
  for (const [name, content] of Object.entries(message.sections ?? {})) {
    parts.push(
      content === null
        ? `[section removed: ${name}]`
        : `[section: ${name}]\n${content}`,
    );
  }
  for (const tool of message.toolsAdded ?? []) {
    parts.push(`[tool added: ${tool.name}]`);
  }
  for (const tool of message.toolsRemoved ?? []) {
    parts.push(`[tool removed: ${tool.name}]`);
  }
  return parts.join("\n") || "(no content)";
}
