export interface DependencyVersionFixInput {
  filePath: string;
  fileContent: string;
  title?: string | null;
  affectedPackages: string | null;
  fixedVersions: string | null;
}

export interface DependencyVersionFix {
  fixedContent: string;
  summary: string;
}

export async function loadPythonDependencyContext(input: Omit<DependencyVersionFixInput, "fixedVersions">): Promise<string> {
  if (!/(^|\/)requirements[-\w]*\.txt$/.test(input.filePath.replace(/\\/g, "/"))) return "";
  const target = firstTokenListValue(input.affectedPackages) ?? packageNameFromTitle(input.title);
  if (!target || !/^[A-Za-z0-9_.-]+$/.test(target)) return "";
  type PackageInfo = { version: string; requires_dist?: string[]; requires_python?: string };
  async function info(name: string, version?: string): Promise<PackageInfo | null> {
    try {
      const response = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}${version ? `/${encodeURIComponent(version)}` : ""}/json`, { signal: AbortSignal.timeout(10_000), redirect: "error" });
      if (!response.ok) return null;
      const data = await response.json() as { info?: PackageInfo };
      return typeof data.info?.version === "string" ? data.info : null;
    } catch { return null; }
  }
  const latestTarget = await info(target);
  const facts = latestTarget ? [`PyPI latest stable ${target}==${latestTarget.version}`] : [];
  const pins = [...input.fileContent.matchAll(/^([A-Za-z0-9_.-]+)==([^\s;#]+)/gm)].slice(0, 30).map((pin) => ({ name: pin[1]!, version: pin[2]! }));
  const installed = await Promise.all(pins.map((pin) => info(pin.name, pin.version)));
  for (let i = 0; i < pins.length; i++) {
    const deps = installed[i]?.requires_dist;
    if (!Array.isArray(deps) || !deps.some((dep) => normalizePackageName(dep.split(/[\s<>=!~;[]/, 1)[0] ?? "") === normalizePackageName(target))) continue;
    const pin = pins[i]!;
    const parent = await info(pin.name);
    if (parent) facts.push(`PyPI latest stable parent ${pin.name}==${parent.version}; dependencies: ${JSON.stringify(parent.requires_dist)}; Python: ${parent.requires_python ?? "unspecified"}`);
  }
  return facts.length ? `\nRegistry facts for the dependency repair:\n${facts.join("\n")}\nChoose compatible patched dependencies. Do not downgrade the vulnerable package to satisfy an old parent constraint; upgrade the parent instead.\n` : "";
}

function firstTokenListValue(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const withoutBrackets = trimmed.replace(/^\[|\]$/g, "");
  const first = withoutBrackets
    .split(/[,\n]/)
    .map((part) => part.trim().replace(/^["']|["']$/g, ""))
    .find(Boolean);

  return first ?? null;
}

function normalizePackageName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/g, "-");
}

function packageNameFromTitle(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const prefix = trimmed.match(/^`?([A-Za-z0-9_.-]+)`?\s*:/);
  if (prefix?.[1]) return prefix[1];
  const cveTitle = trimmed.match(/\bin\s+`?([A-Za-z0-9_.-]+)`?\s*$/i);
  return cveTitle?.[1] ?? null;
}

function fixedRequirement(packageName: string, fixedVersion: string): string {
  const trimmed = fixedVersion.trim();
  if (/^(===|==|~=|!=|<=|>=|<|>)/.test(trimmed)) {
    return `${packageName}${trimmed}`;
  }
  return `${packageName}==${trimmed}`;
}

function requirementPackageName(line: string): string | null {
  const withoutComment = line.split("#", 1)[0]?.trim() ?? "";
  if (!withoutComment || withoutComment.startsWith("-") || withoutComment.includes("://")) return null;
  const match = withoutComment.match(/^([A-Za-z0-9_.-]+)\s*(?:\[[^\]]+\])?\s*(?:===|==|~=|!=|<=|>=|<|>|$)/);
  return match?.[1] ?? null;
}

export function tryApplyDependencyVersionFix(input: DependencyVersionFixInput): DependencyVersionFix | null {
  const normalizedPath = input.filePath.replace(/\\/g, "/").toLowerCase();
  if (!/(^|\/)requirements(?:[-\w]*)?\.txt$/.test(normalizedPath)) return null;

  const packageName = firstTokenListValue(input.affectedPackages) ?? packageNameFromTitle(input.title);
  const fixedVersion = firstTokenListValue(input.fixedVersions);
  if (!packageName || !fixedVersion) return null;

  const wanted = normalizePackageName(packageName);
  const replacement = fixedRequirement(packageName, fixedVersion);
  const lineEnding = input.fileContent.includes("\r\n") ? "\r\n" : "\n";
  const hasTrailingNewline = /\r?\n$/.test(input.fileContent);
  const lines = input.fileContent.split(/\r?\n/);
  if (hasTrailingNewline) lines.pop();

  let replaced = false;
  const nextLines: string[] = [];
  for (const line of lines) {
    const currentPackage = requirementPackageName(line);
    if (currentPackage && normalizePackageName(currentPackage) === wanted) {
      if (!replaced) {
        nextLines.push(replacement);
        replaced = true;
      }
      continue;
    }
    nextLines.push(line);
  }

  if (!replaced) {
    nextLines.push(replacement);
  }

  const fixedContent = `${nextLines.join(lineEnding)}${hasTrailingNewline ? lineEnding : ""}`;
  if (fixedContent === input.fileContent) return null;

  return {
    fixedContent,
    summary: `Updated ${packageName} to ${fixedVersion} in ${input.filePath} and removed duplicate vulnerable pins.`,
  };
}
