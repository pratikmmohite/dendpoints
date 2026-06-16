import * as vscode from "vscode";
import { scanWorkspaceForApiCalls } from "./apiScanner";
import type { ApiCall, ApiFileGroup } from "./types";

export function normalizeApiPath(url: string): string {
  const path = url.trim();
  return path.startsWith("/") ? path : `/${path}`;
}

export function formatEndpointLabel(method: string, url: string): string {
  const verb = method.trim().toUpperCase();
  return `${verb} ${normalizeApiPath(url)}`;
}

export class ApiCallItem extends vscode.TreeItem {
  constructor(
    public readonly apiCall: ApiCall,
    public readonly relativePath: string,
  ) {
    const label = formatEndpointLabel(apiCall.method, apiCall.url);
    super(label, vscode.TreeItemCollapsibleState.None);

    this.description = `${relativePath} · L${apiCall.line + 1}`;
    this.tooltip = new vscode.MarkdownString(
      `**${label}**\n\n` +
        `File: \`${relativePath}\` (line ${apiCall.line + 1})\n\n` +
        `\`\`\`\n${apiCall.snippet}\n\`\`\``,
    );
    this.command = {
      command: "dendpoint.openApiCall",
      title: "Open Endpoint",
      arguments: [apiCall],
    };
    this.iconPath = new vscode.ThemeIcon("globe");
    this.contextValue = "apiCall";
  }
}

const PATH_COMPARE_OPTIONS: Intl.CollatorOptions = {
  numeric: true,
  sensitivity: "base",
};

function compareEndpoints(
  a: { call: ApiCall; relativePath: string },
  b: { call: ApiCall; relativePath: string },
): number {
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

function matchesSearch(
  { call, relativePath }: { call: ApiCall; relativePath: string },
  query: string,
): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  const haystack = [
    formatEndpointLabel(call.method, call.url),
    normalizeApiPath(call.url),
    call.method,
    relativePath,
    call.snippet,
  ]
    .join("\n")
    .toLowerCase();

  return haystack.includes(normalizedQuery);
}

class MessageItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("info");
  }
}

export class ApiCallsTreeProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private groups: ApiFileGroup[] = [];
  private isLoading = false;
  private statusMessage: string | undefined;
  private searchQuery = "";

  constructor(
    private readonly getWorkspaceFolder: () => vscode.WorkspaceFolder | undefined,
    private readonly getScanOptions: () => {
      extensionPath: string;
      useRoslynAnalyzer: boolean;
    },
  ) {}

  get filterQuery(): string {
    return this.searchQuery;
  }

  refresh(): void {
    void this.loadApiCalls();
  }

  setSearchQuery(query: string): void {
    this.searchQuery = query;
    void this.updateFilterContext();
    this._onDidChangeTreeData.fire();
  }

  clearSearch(): void {
    this.setSearchQuery("");
  }

  private async updateFilterContext(): Promise<void> {
    await vscode.commands.executeCommand(
      "setContext",
      "dendpoint.filterActive",
      this.searchQuery.trim().length > 0,
    );
  }

  private getEndpoints(): { call: ApiCall; relativePath: string }[] {
    const endpoints = this.groups.flatMap((group) =>
      group.calls.map((call) => ({ call, relativePath: group.relativePath })),
    );

    if (!this.searchQuery.trim()) {
      return endpoints;
    }

    return endpoints.filter((endpoint) => matchesSearch(endpoint, this.searchQuery));
  }

  async loadApiCalls(): Promise<void> {
    const folder = this.getWorkspaceFolder();
    if (!folder) {
      this.groups = [];
      this.statusMessage = undefined;
      this._onDidChangeTreeData.fire();
      return;
    }

    this.isLoading = true;
    this.statusMessage = undefined;
    this._onDidChangeTreeData.fire();

    try {
      const result = await scanWorkspaceForApiCalls(folder, this.getScanOptions());
      this.groups = result.groups;
      this.statusMessage =
        result.groups.length === 0 ? result.message : undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(
        `DEndpoint: failed to scan API endpoints — ${message}`,
      );
      this.groups = [];
      this.statusMessage = undefined;
    } finally {
      this.isLoading = false;
      this._onDidChangeTreeData.fire();
    }
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (this.isLoading) {
      return [new MessageItem("Scanning ASP.NET Core project...")];
    }

    const folder = this.getWorkspaceFolder();
    if (!folder) {
      return [new MessageItem("Open an ASP.NET Core folder to scan endpoints")];
    }

    if (!element) {
      if (this.statusMessage) {
        return [new MessageItem(this.statusMessage)];
      }
      if (this.groups.length === 0) {
        return [new MessageItem("No API endpoints found")];
      }

      const endpoints = this.getEndpoints().sort(compareEndpoints);
      if (endpoints.length === 0 && this.searchQuery.trim()) {
        return [
          new MessageItem(`No endpoints match "${this.searchQuery.trim()}"`),
        ];
      }

      return endpoints.map(
        ({ call, relativePath }) => new ApiCallItem(call, relativePath),
      );
    }

    return [];
  }
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
