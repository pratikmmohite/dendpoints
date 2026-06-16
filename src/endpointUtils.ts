import * as vscode from "vscode";
import type { ApiCall } from "./types";

export interface EndpointRow {
  call: ApiCall;
  relativePath: string;
}

const PATH_COMPARE_OPTIONS: Intl.CollatorOptions = {
  numeric: true,
  sensitivity: "base",
};

export function normalizeApiPath(url: string): string {
  const path = url.trim();
  return path.startsWith("/") ? path : `/${path}`;
}

export function formatEndpointLabel(method: string, url: string): string {
  const verb = method.trim().toUpperCase();
  return `${verb} ${normalizeApiPath(url)}`;
}

export function compareEndpoints(a: EndpointRow, b: EndpointRow): number {
  const pathCompare = normalizeApiPath(a.call.url).localeCompare(
    normalizeApiPath(b.call.url),
    undefined,
    PATH_COMPARE_OPTIONS,
  );
  if (pathCompare !== 0) {
    return pathCompare;
  }

  const methodCompare = a.call.method
    .trim()
    .toUpperCase()
    .localeCompare(b.call.method.trim().toUpperCase());
  if (methodCompare !== 0) {
    return methodCompare;
  }

  return a.relativePath.localeCompare(b.relativePath, undefined, PATH_COMPARE_OPTIONS);
}

export function matchesEndpoint(row: EndpointRow, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  const haystack = [
    formatEndpointLabel(row.call.method, row.call.url),
    normalizeApiPath(row.call.url),
    row.call.method,
    row.relativePath,
    row.call.snippet,
  ]
    .join("\n")
    .toLowerCase();

  return haystack.includes(normalizedQuery);
}

export function sortEndpoints(rows: EndpointRow[]): EndpointRow[] {
  return [...rows].sort(compareEndpoints);
}

export async function openApiCall(apiCall: ApiCall): Promise<void> {
  const document = await vscode.workspace.openTextDocument(apiCall.filePath);
  const editor = await vscode.window.showTextDocument(document, {
    preview: false,
    selection: new vscode.Range(
      apiCall.line,
      apiCall.column,
      apiCall.line,
      apiCall.column,
    ),
  });

  const position = new vscode.Position(apiCall.line, apiCall.column);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(
    new vscode.Range(position, position),
    vscode.TextEditorRevealType.InCenter,
  );
}
