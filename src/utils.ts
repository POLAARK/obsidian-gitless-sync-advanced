import { base64ToArrayBuffer } from "obsidian";

const TEXT_EXTENSIONS = [
  ".css",
  ".md",
  ".json",
  ".txt",
  ".csv",
  ".js",
  ".log",
] as const;

/**
 * Decodes a base64 encoded string, this properly
 * handles emojis and other non ASCII chars.
 *
 * @param s base64 encoded string
 * @returns Decoded string
 */
export function decodeBase64String(s: string): string {
  const buffer = base64ToArrayBuffer(s);
  const decoder = new TextDecoder();
  return decoder.decode(buffer);
}

/**
 * Copies the provided text to the system clipboard.
 * Uses the modern Clipboard API with a fallback to older APIs.
 *
 * @param text The string to be copied to clipboard
 * @returns A promise that resolves when the text has been copied
 */
export async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    // Fallback for devices like iOS that don't support Clipboard API
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);

    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  }
}

/**
 * Checks if a file path has one of the predefined text extensions.
 * This is a best guess at best.
 *
 * @param filePath The path of the file to check
 * @returns True if the file has a text extension, false otherwise
 */
export function hasTextExtension(filePath: string) {
  for (const extension of TEXT_EXTENSIONS) {
    if (filePath.endsWith(extension)) {
      return true;
    }
  }
  return false;
}

/**
 * Patterns that are always ignored, regardless of user settings.
 *
 * We hardcode the plugin configuration files here on purpose: the GitHub
 * token is stored in plain text in the plugin `data.json`, so syncing it to
 * the remote repository (when syncing the config dir) would leak it.
 */
export const BUILTIN_IGNORE_PATTERNS = [
  ".DS_Store",
  ".obsidian/plugins/github-gitless-sync/data.json",
  ".obsidian/plugins/github-gitless-sync-advanced/data.json",
  ".obsidian/github-sync.log",
  ".obsidian/github-gitless-sync-advanced.log",
  // Plugin binaries, these are large and useless to sync.
  ".obsidian/plugins/**/main.js",
  ".obsidian/plugins/**/styles.css",
] as const;

/**
 * Parses the user provided ignore patterns.
 * One pattern per line, `#` starts a comment.
 */
export function parseIgnorePatterns(raw: string | null | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * Converts a simple glob pattern into a regular expression.
 * Supports `*` (any char except `/`), `**` (any chars including `/`)
 * and `?` (a single char except `/`).
 */
function globToRegExp(glob: string): RegExp {
  const pattern = glob.trim();
  if (pattern === "") {
    // A pattern that never matches
    return /$^/;
  }

  let regex = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          // `**/` matches zero or more leading directories
          i++;
          regex += "(?:.*/)?";
        } else {
          regex += ".*";
        }
      } else {
        regex += "[^/]*";
      }
    } else if (char === "?") {
      regex += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(char)) {
      regex += `\\${char}`;
    } else {
      regex += char;
    }
  }
  return new RegExp(`^${regex}$`);
}

/**
 * Checks whether a file path matches any of the provided glob patterns.
 * Patterns without a slash also match the file name at any depth, and
 * patterns are additionally treated as directory prefixes.
 */
export function matchesIgnorePattern(
  filePath: string,
  patterns: string[],
): boolean {
  const normalized = filePath.replace(/^\.\//, "");
  return patterns.some((raw) => {
    const pattern = raw.trim();
    if (pattern === "") {
      return false;
    }
    const variants = [pattern, `${pattern.replace(/\/+$/, "")}/**`];
    for (const variant of variants) {
      if (globToRegExp(variant).test(normalized)) {
        return true;
      }
      if (!variant.includes("/")) {
        const baseName = normalized.split("/").pop() ?? "";
        if (globToRegExp(variant).test(baseName)) {
          return true;
        }
      }
    }
    return false;
  });
}

/**
 * Returns true when the file path should be ignored when syncing.
 * User patterns are added on top of the builtin ones.
 */
export function isIgnoredPath(
  filePath: string,
  userPatterns: string[] = [],
): boolean {
  return matchesIgnorePattern(filePath, [
    ...BUILTIN_IGNORE_PATTERNS,
    ...userPatterns,
  ]);
}

/**
 * Retries an async function until its return value satisfies a condition or max retries is reached.
 * Uses exponential backoff between retry attempts.
 *
 * @param fn - The async function to execute and potentially retry
 * @param condition - Function that evaluates if the result is acceptable
 * @param maxRetries - Maximum number of retry attempts (default: 5)
 * @param initialDelay - Initial delay in ms before first retry (default: 1000)
 * @param backoffFactor - Multiplicative factor for delay between retries (default: 2)
 * @returns The result of the function execution
 */
export async function retryUntil<T>(
  fn: () => Promise<T>,
  condition: (result: T) => boolean,
  maxRetries: number = 5,
  initialDelay: number = 1000,
  backoffFactor: number = 2,
): Promise<T> {
  let retries = 0;
  let delay = initialDelay;

  while (true) {
    const result = await fn();

    if (condition(result) || retries >= maxRetries) {
      return result;
    }

    retries++;
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay *= backoffFactor;
  }
}
