/**
 * Always-on context cost: how much of a row every session carries before the
 * first prompt (ARCHITECTURE.md「常時コスト」, design §6.1).
 *
 * The figure is a **static estimate in characters** of the text the harness
 * puts into its context for the row. Where the text's shape was measured
 * (Copilot CLI, by capturing the request it sends — see 「スパイクの判定」), the
 * count follows that shape exactly; where it was not, it follows the official
 * description of what is loaded. Characters are Unicode code points.
 *
 * Tokens are given alongside and are always a guess (推測): there is no
 * official conversion, so the figure uses the ratios measured on this kind of
 * text — 3.2 ASCII characters per token, 0.87 tokens per other character.
 */

export const ASCII_CHARS_PER_TOKEN = 3.2;
export const OTHER_TOKENS_PER_CHAR = 0.87;

export interface Cost {
  chars: number;
  /** 推測. Rounded. */
  tokens: number;
}

/** Code points, not UTF-16 units: a kanji or an emoji counts once. */
export function codepoints(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

export function costOf(text: string): Cost {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.codePointAt(0)! < 0x80) ascii++;
    else other++;
  }
  return { chars: ascii + other, tokens: Math.round(ascii / ASCII_CHARS_PER_TOKEN + other * OTHER_TOKENS_PER_CHAR) };
}

export const ZERO: Cost = { chars: 0, tokens: 0 };

/* ---- the text each harness carries, per kind ----------------------- */

/** Claude: skill name + description + when_to_use (official: plugins/measure). */
export function claudeSkillText(name: string, description = "", whenToUse = ""): string {
  return [name, description, whenToUse].filter((s) => s !== "").join(" ");
}

/** Claude: an agent's or a command's name + description. */
export function claudeListingText(name: string, description = ""): string {
  return description === "" ? name : `${name} ${description}`;
}

/** Copilot CLI: one `<available_skills>` entry, as measured in 1.0.107. */
export function copilotSkillText(name: string, description: string, location: "project" | "user"): string {
  return `<skill>\n  <name>${name}</name>\n  <description>${description}</description>\n  <location>${location}</location>\n</skill>\n`;
}

/** Copilot CLI: one line in the task tool's custom-agent list, as measured in 1.0.107. */
export function copilotAgentText(name: string, description: string): string {
  return `- **${name}**: ${description}\n\n`;
}

/**
 * Copilot CLI: an instruction file that is always included, with the files its
 * `@` references pull in appended inside it (both shapes measured in 1.0.107).
 */
export function copilotInstructionText(body: string, imports: readonly { path: string; text: string }[] = []): string {
  const imported = imports
    .map((i) => `<imported_custom_instruction source="${i.path}">\n${i.text}</imported_custom_instruction>\n\n`)
    .join("");
  return `<custom_instruction>\n${body}\n${imported}</custom_instruction>\n\n`;
}

/** Copilot CLI: the table row an `applyTo` file that did not match gets instead of its body (measured). */
export function copilotConditionalRowText(pattern: string, relPath: string, description = ""): string {
  return `| ${pattern} | '${relPath}' | ${description} |\n`;
}
