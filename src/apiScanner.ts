import * as fs from "fs";
import * as path from "path";
import type * as vscode from "vscode";
import {
  isDotNetAnalyzerAvailable,
  scanWithDotNetAnalyzer,
} from "./dotnetAnalyzer";
import {
  buildRouteConstantIndex,
  displayRouteValue,
  resolveRouteReference,
  type RouteConstantIndex,
} from "./routeConstants";
import type { ApiCall, ApiFileGroup } from "./types";

const SOURCE_EXTENSIONS = new Set([".cs"]);

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "bin",
  "obj",
  "coverage",
  "vendor",
  ".vscode-test",
]);

const ASPNET_CORE_PROJECT_MARKERS = [
  /Microsoft\.NET\.Sdk\.Web/i,
  /Microsoft\.AspNetCore/i,
  /AspNetCore/i,
];

const ROUTE_ATTRIBUTE_LITERAL_REGEX =
  /\[Route\s*\(\s*["']([^"']*)["']\s*\)\]/i;

const ROUTE_ATTRIBUTE_REFERENCE_REGEX = /\[Route\s*\(\s*([\w.]+)\s*\)\]/i;

const HTTP_ATTRIBUTE_LITERAL_REGEX =
  /\[(Http(Get|Post|Put|Patch|Delete|Head|Options))(?:\(\s*["']([^"']*)["']\s*\))?\]/i;

const HTTP_ATTRIBUTE_REFERENCE_REGEX =
  /\[(Http(Get|Post|Put|Patch|Delete|Head|Options))(?:\(\s*([\w.]+)\s*\))?\]/i;

export interface ScanResult {
  groups: ApiFileGroup[];
  message?: string;
  analyzer?: "roslyn" | "regex";
}

export function getTotalCallCount(groups: ApiFileGroup[]): number {
  return groups.reduce((sum, group) => sum + group.calls.length, 0);
}

function shouldScanFile(filePath: string): boolean {
  return SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isAspNetCoreProjectFile(content: string): boolean {
  return ASPNET_CORE_PROJECT_MARKERS.some((marker) => marker.test(content));
}

async function findAspNetCoreProjectRoots(
  root: string,
): Promise<Set<string>> {
  const projectRoots = new Set<string>();
  const queue = [root];

  while (queue.length > 0) {
    const dir = queue.pop();
    if (!dir) {
      continue;
    }

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          queue.push(fullPath);
        }
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".csproj")) {
        continue;
      }

      try {
        const content = await fs.promises.readFile(fullPath, "utf8");
        if (isAspNetCoreProjectFile(content)) {
          projectRoots.add(path.dirname(fullPath));
        }
      } catch {
        continue;
      }
    }
  }

  return projectRoots;
}

function isUnderProjectRoot(filePath: string, projectRoots: Set<string>): boolean {
  for (const projectRoot of projectRoots) {
    const relative = path.relative(projectRoot, filePath);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return true;
    }
  }
  return false;
}

async function collectSourceFiles(
  projectRoots: Set<string>,
  results: string[],
): Promise<void> {
  for (const projectRoot of projectRoots) {
    await collectSourceFilesInDir(projectRoot, results);
  }
}

async function collectSourceFilesInDir(
  dir: string,
  results: string[],
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        await collectSourceFilesInDir(fullPath, results);
      }
      continue;
    }

    if (entry.isFile() && shouldScanFile(fullPath)) {
      results.push(fullPath);
    }
  }
}

function lineColumnFromIndex(
  content: string,
  index: number,
): { line: number; column: number } {
  const before = content.slice(0, index);
  const lines = before.split("\n");
  return {
    line: lines.length - 1,
    column: lines[lines.length - 1]?.length ?? 0,
  };
}

function normalizeRoute(route: string): string {
  const trimmed = route.trim();
  if (!trimmed) {
    return "/";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function joinRoutes(baseRoute: string | undefined, methodRoute: string | undefined): string {
  const base = normalizeRoute(baseRoute ?? "");
  const suffix = (methodRoute ?? "").trim();

  if (!suffix) {
    return base === "/" ? "/" : base.replace(/\/+$/, "") || "/";
  }

  const normalizedSuffix = normalizeRoute(suffix);
  if (base === "/" || base === "") {
    return normalizedSuffix;
  }

  return `${base.replace(/\/+$/, "")}${normalizedSuffix}`;
}

function applyRouteTokens(
  route: string,
  controllerName: string | undefined,
  actionName: string | undefined,
): string {
  const controllerToken = controllerName
    ? controllerName.replace(/Controller$/i, "")
    : "[controller]";

  return route
    .replace(/\[controller\]/gi, controllerToken)
    .replace(/\[action\]/gi, actionName ?? "[action]");
}

function pushEndpoint(
  calls: ApiCall[],
  seen: Set<string>,
  filePath: string,
  content: string,
  index: number,
  method: string,
  url: string,
): void {
  const { line, column } = lineColumnFromIndex(content, index);
  const dedupeKey = `${line}:${column}:${method}:${url}`;
  if (seen.has(dedupeKey)) {
    return;
  }

  seen.add(dedupeKey);
  const lineText = content.split("\n")[line]?.trim() ?? "";
  calls.push({
    filePath,
    line,
    column,
    method: method.toUpperCase(),
    url,
    snippet: lineText.length > 120 ? `${lineText.slice(0, 117)}...` : lineText,
  });
}

function resolveRouteExpression(
  expression: string,
  index: RouteConstantIndex,
): string {
  const trimmed = expression.trim();
  const literalMatch = trimmed.match(/^["']([^"']*)["']$/);
  if (literalMatch) {
    return literalMatch[1] ?? "";
  }

  const resolved = resolveRouteReference(trimmed, index);
  if (resolved !== undefined) {
    return resolved;
  }

  return `{${trimmed}}`;
}

function scanMinimalApis(
  filePath: string,
  content: string,
  calls: ApiCall[],
  seen: Set<string>,
  index: RouteConstantIndex,
): void {
  const groupPrefixes = collectMapGroupPrefixes(content, index);
  const regex =
    /\b(\w+)\.Map(Get|Post|Put|Patch|Delete|Head|Options)\s*\(\s*(["'][^"']*["']|[\w.]+)\s*,/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const receiver = match[1] ?? "";
    const method = match[2]?.toUpperCase() ?? "GET";
    const route = normalizeRoute(resolveRouteExpression(match[3] ?? "", index));
    const groupPrefix = groupPrefixes.get(receiver);
    const fullRoute = groupPrefix ? joinRoutes(groupPrefix, route) : route;

    pushEndpoint(calls, seen, filePath, content, match.index, method, fullRoute);
  }
}

function isAttributeLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("[") || trimmed === "" || trimmed.startsWith("//");
}

function collectAttributeBlock(
  lines: string[],
  startLine: number,
): { attributes: string[]; declarationLine: number } {
  const attributes: string[] = [];
  let lineIndex = startLine;

  while (lineIndex < lines.length) {
    const trimmed = lines[lineIndex]?.trim() ?? "";
    if (trimmed.startsWith("[")) {
      attributes.push(trimmed);
      lineIndex++;
      continue;
    }
    if (trimmed === "" || trimmed.startsWith("//")) {
      lineIndex++;
      continue;
    }
    break;
  }

  return { attributes, declarationLine: lineIndex };
}

function parseRouteAttribute(
  attribute: string,
  index: RouteConstantIndex,
): string | undefined {
  const literalMatch = attribute.match(ROUTE_ATTRIBUTE_LITERAL_REGEX);
  if (literalMatch) {
    return literalMatch[1];
  }

  const referenceMatch = attribute.match(ROUTE_ATTRIBUTE_REFERENCE_REGEX);
  if (referenceMatch?.[1]) {
    return displayRouteValue(undefined, referenceMatch[1], index);
  }

  return undefined;
}

function parseHttpAttributes(
  attributes: string[],
  index: RouteConstantIndex,
): Array<{ method: string; route?: string }> {
  const endpoints: Array<{ method: string; route?: string }> = [];
  let explicitRoute: string | undefined;

  for (const attribute of attributes) {
    const routeValue = parseRouteAttribute(attribute, index);
    if (routeValue !== undefined) {
      explicitRoute = routeValue;
    }

    const httpLiteralMatch = attribute.match(HTTP_ATTRIBUTE_LITERAL_REGEX);
    if (httpLiteralMatch?.[2]) {
      endpoints.push({
        method: httpLiteralMatch[2].toUpperCase(),
        route: httpLiteralMatch[3] ?? explicitRoute,
      });
      continue;
    }

    const httpReferenceMatch = attribute.match(HTTP_ATTRIBUTE_REFERENCE_REGEX);
    if (httpReferenceMatch?.[2]) {
      const routeReference = httpReferenceMatch[3];
      const route = routeReference
        ? displayRouteValue(undefined, routeReference, index)
        : explicitRoute;

      endpoints.push({
        method: httpReferenceMatch[2].toUpperCase(),
        route,
      });
    }
  }

  return endpoints;
}

function isClassDeclaration(line: string): boolean {
  return /\bclass\s+\w+/.test(line);
}

function findMethodAttributeStart(lines: string[], startLine: number): number {
  let lineIndex = startLine;
  while (lineIndex > 0) {
    const previous = lines[lineIndex - 1]?.trim() ?? "";
    if (previous.startsWith("[")) {
      lineIndex--;
      continue;
    }
    if (previous === "" || previous.startsWith("//")) {
      lineIndex--;
      continue;
    }
    break;
  }
  return lineIndex;
}

function collectMapGroupPrefixes(
  content: string,
  index: RouteConstantIndex,
): Map<string, string> {
  const prefixes = new Map<string, string>();
  const regex =
    /(\w+)\s*=\s*[\w.]+\.MapGroup\s*\(\s*(["'][^"']*["']|[\w.]+)\s*\)/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const variable = match[1];
    const routeExpression = match[2];
    if (variable && routeExpression) {
      prefixes.set(
        variable,
        normalizeRoute(resolveRouteExpression(routeExpression, index)),
      );
    }
  }

  return prefixes;
}

function resolveClassRoute(
  lines: string[],
  lineIndex: number,
  index: RouteConstantIndex,
): string | undefined {
  for (let lookback = lineIndex - 1; lookback >= 0 && lookback >= lineIndex - 12; lookback--) {
    const previous = lines[lookback]?.trim() ?? "";
    if (!isAttributeLine(previous) && previous !== "") {
      break;
    }

    const routeValue = parseRouteAttribute(previous, index);
    if (routeValue !== undefined) {
      return routeValue;
    }
  }

  return undefined;
}

function scanControllerEndpoints(
  filePath: string,
  content: string,
  calls: ApiCall[],
  seen: Set<string>,
  index: RouteConstantIndex,
): void {
  const lines = content.split("\n");
  let classRoute: string | undefined;
  let controllerName: string | undefined;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? "";
    const trimmed = line.trim();

    const classMatch = trimmed.match(
      /(?:public|internal|private|protected)?\s*(?:partial\s+)?class\s+(\w+)\b/,
    );
    if (classMatch?.[1]) {
      controllerName = classMatch[1];
      classRoute = resolveClassRoute(lines, lineIndex, index);
      continue;
    }

    if (!trimmed.startsWith("[")) {
      continue;
    }

    const attributeStart = findMethodAttributeStart(lines, lineIndex);
    const { attributes, declarationLine } = collectAttributeBlock(lines, attributeStart);
    if (attributes.length === 0) {
      continue;
    }

    const httpEndpoints = parseHttpAttributes(attributes, index);
    if (httpEndpoints.length === 0) {
      continue;
    }

    const declaration = lines[declarationLine]?.trim() ?? "";
    if (isClassDeclaration(declaration)) {
      continue;
    }
    const methodMatch = declaration.match(
      /(?:public|internal|private|protected)\s+(?:async\s+)?[\w<>,\[\]?]+\s+(\w+)\s*\(/,
    );
    const actionName = methodMatch?.[1];

    const lineStartOffset =
      attributeStart === 0 ? 0 : lines.slice(0, attributeStart).join("\n").length + 1;
    const attributeIndex = content.indexOf(attributes[0] ?? "", lineStartOffset);

    for (const endpoint of httpEndpoints) {
      const combinedRoute = applyRouteTokens(
        joinRoutes(classRoute, endpoint.route),
        controllerName,
        actionName,
      );
      pushEndpoint(
        calls,
        seen,
        filePath,
        content,
        attributeIndex >= 0 ? attributeIndex : lineStartOffset,
        endpoint.method,
        combinedRoute,
      );
    }

    lineIndex = Math.max(lineIndex, declarationLine);
  }
}

function scanFileContent(
  filePath: string,
  content: string,
  index: RouteConstantIndex,
): ApiCall[] {
  const calls: ApiCall[] = [];
  const seen = new Set<string>();

  scanMinimalApis(filePath, content, calls, seen, index);
  scanControllerEndpoints(filePath, content, calls, seen, index);

  return calls.sort((a, b) => a.line - b.line);
}

function buildGroupsFromCalls(
  calls: ApiCall[],
  root: string,
  projectRoots: Set<string>,
): ApiFileGroup[] {
  const grouped = new Map<string, ApiFileGroup>();

  for (const call of calls) {
    const projectRoot = [...projectRoots].find((projectRoot) => {
      const relative = path.relative(projectRoot, call.filePath);
      return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
    });

    const relativePath = projectRoot
      ? path.relative(projectRoot, call.filePath) || path.basename(call.filePath)
      : path.relative(root, call.filePath) || path.basename(call.filePath);

    const existing = grouped.get(relativePath);
    if (existing) {
      existing.calls.push(call);
      continue;
    }

    grouped.set(relativePath, {
      filePath: call.filePath,
      relativePath,
      calls: [call],
    });
  }

  for (const group of grouped.values()) {
    group.calls.sort((a, b) => a.line - b.line);
  }

  return [...grouped.values()].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  );
}

async function scanWorkspaceWithRegex(
  root: string,
  projectRoots: Set<string>,
): Promise<ApiFileGroup[]> {
  const files: string[] = [];
  await collectSourceFiles(projectRoots, files);

  const fileContents = new Map<string, string>();
  for (const filePath of files) {
    if (!isUnderProjectRoot(filePath, projectRoots)) {
      continue;
    }

    try {
      const content = await fs.promises.readFile(filePath, "utf8");
      fileContents.set(filePath, content);
    } catch {
      continue;
    }
  }

  const routeConstants = buildRouteConstantIndex(fileContents.values());
  const calls: ApiCall[] = [];

  for (const [filePath, content] of fileContents) {
    calls.push(...scanFileContent(filePath, content, routeConstants));
  }

  return buildGroupsFromCalls(calls, root, projectRoots);
}

export interface ScanOptions {
  extensionPath?: string;
  useRoslynAnalyzer?: boolean;
}

export async function scanWorkspaceForApiCalls(
  workspaceFolder: vscode.WorkspaceFolder,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const root = workspaceFolder.uri.fsPath;
  const projectRoots = await findAspNetCoreProjectRoots(root);

  if (projectRoots.size === 0) {
    return {
      groups: [],
      message: "No ASP.NET Core .csproj found in workspace",
    };
  }

  const useRoslyn = options.useRoslynAnalyzer ?? true;
  const extensionPath = options.extensionPath;

  if (useRoslyn && extensionPath && isDotNetAnalyzerAvailable(extensionPath)) {
    const dotnetResult = await scanWithDotNetAnalyzer(root, extensionPath);
    if (dotnetResult) {
      return {
        groups: buildGroupsFromCalls(dotnetResult.calls, root, projectRoots),
        analyzer: "roslyn",
        message: dotnetResult.warning,
      };
    }
  }

  const groups = await scanWorkspaceWithRegex(root, projectRoots);
  return {
    groups,
    analyzer: "regex",
    message:
      useRoslyn && extensionPath && !isDotNetAnalyzerAvailable(extensionPath)
        ? ".NET analyzer not bundled. Using regex scanner."
        : undefined,
  };
}
