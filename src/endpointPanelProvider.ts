import * as vscode from "vscode";
import { scanWorkspaceForApiCalls } from "./apiScanner";
import {
  formatEndpointLabel,
  openApiCall,
  sortEndpoints,
  type EndpointRow,
} from "./endpointUtils";

type PanelStatus = "loading" | "message" | "ready";

interface PanelState {
  status: PanelStatus;
  message?: string;
  endpoints: EndpointRow[];
}

export class EndpointPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "dendpoint.apiCalls";

  private webviewView: vscode.WebviewView | undefined;
  private state: PanelState = { status: "loading", endpoints: [] };
  private filterQuery = "";

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getWorkspaceFolder: () => vscode.WorkspaceFolder | undefined,
    private readonly getScanOptions: () => {
      extensionPath: string;
      useRoslynAnalyzer: boolean;
    },
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.webviewView = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtml();
    webviewView.webview.onDidReceiveMessage((message: { type: string; index?: number; active?: boolean }) => {
      void this.handleMessage(message);
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.postState();
      }
    });

    this.postState();
    void this.refresh();
  }

  clearSearch(): void {
    this.filterQuery = "";
    void this.setFilterActive(false);
    this.webviewView?.webview.postMessage({ type: "clearSearch" });
    this.postState();
  }

  async refresh(): Promise<void> {
    const folder = this.getWorkspaceFolder();
    if (!folder) {
      this.state = {
        status: "message",
        message: "Open an ASP.NET Core folder to scan endpoints",
        endpoints: [],
      };
      this.postState();
      return;
    }

    this.state = { status: "loading", endpoints: [] };
    this.postState();

    try {
      const result = await scanWorkspaceForApiCalls(folder, this.getScanOptions());
      const endpoints = sortEndpoints(
        result.groups.flatMap((group) =>
          group.calls.map((call) => ({ call, relativePath: group.relativePath })),
        ),
      );

      if (endpoints.length === 0) {
        this.state = {
          status: "message",
          message: result.message ?? "No API endpoints found",
          endpoints: [],
        };
      } else {
        this.state = { status: "ready", endpoints };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(
        `DEndpoint: failed to scan API endpoints — ${message}`,
      );
      this.state = {
        status: "message",
        message: "Failed to scan API endpoints",
        endpoints: [],
      };
    }

    this.postState();
  }

  private async handleMessage(message: {
    type: string;
    index?: number;
    active?: boolean;
  }): Promise<void> {
    switch (message.type) {
      case "open":
        if (typeof message.index === "number") {
          const row = this.state.endpoints[message.index];
          if (row) {
            await openApiCall(row.call);
          }
        }
        break;
      case "filterChanged":
        await this.setFilterActive(Boolean(message.active));
        break;
      default:
        break;
    }
  }

  private async setFilterActive(active: boolean): Promise<void> {
    await vscode.commands.executeCommand("setContext", "dendpoint.filterActive", active);
  }

  private postState(): void {
    const payload = {
      type: "update",
      status: this.state.status,
      message: this.state.message,
      query: this.filterQuery,
      endpoints: this.state.endpoints.map((row, index) => ({
        index,
        label: formatEndpointLabel(row.call.method, row.call.url),
        description: `${row.relativePath} · L${row.call.line + 1}`,
        searchText: [
          formatEndpointLabel(row.call.method, row.call.url),
          row.call.method,
          row.call.url,
          row.relativePath,
          row.call.snippet,
        ].join("\n"),
      })),
    };

    void this.webviewView?.webview.postMessage(payload);
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';"
  />
  <style>
    * { box-sizing: border-box; }

    body {
      margin: 0;
      padding: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .search-bar {
      flex-shrink: 0;
      padding: 8px 10px 4px;
    }

    .search-input-wrap {
      position: relative;
      display: flex;
      align-items: center;
    }

    .search-icon {
      position: absolute;
      left: 8px;
      color: var(--vscode-input-placeholderForeground);
      font-size: 13px;
      pointer-events: none;
      line-height: 1;
    }

    #filter {
      width: 100%;
      height: 26px;
      padding: 0 28px;
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font: inherit;
      outline: none;
    }

    #filter:focus {
      border-color: var(--vscode-focusBorder);
    }

    #filter::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }

    #clear {
      position: absolute;
      right: 4px;
      width: 20px;
      height: 20px;
      border: none;
      border-radius: 2px;
      background: transparent;
      color: var(--vscode-input-foreground);
      cursor: pointer;
      display: none;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      line-height: 1;
      padding: 0;
    }

    #clear:hover {
      background: var(--vscode-toolbar-hoverBackground);
    }

    #clear.visible {
      display: inline-flex;
    }

    #count {
      flex-shrink: 0;
      padding: 2px 12px 6px;
      color: var(--vscode-descriptionForeground);
      font-size: 0.92em;
    }

    #count.hidden {
      display: none;
    }

    .list {
      flex: 1;
      overflow: auto;
      padding-bottom: 8px;
    }

    .item {
      display: flex;
      align-items: center;
      gap: 6px;
      height: 22px;
      padding: 0 8px 0 6px;
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
    }

    .item:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .item:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }

    .item:focus .description {
      color: var(--vscode-list-activeSelectionForeground);
      opacity: 0.85;
    }

    .icon {
      flex-shrink: 0;
      width: 16px;
      text-align: center;
      opacity: 0.9;
      font-size: 13px;
      line-height: 1;
    }

    .label {
      flex: 0 1 auto;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .description {
      flex: 1 1 auto;
      margin-left: 8px;
      text-align: right;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--vscode-descriptionForeground);
      opacity: 0.85;
      font-size: 0.92em;
    }

    .status {
      padding: 8px 12px;
      color: var(--vscode-descriptionForeground);
    }

    .hidden {
      display: none;
    }
  </style>
</head>
<body>
  <div class="search-bar">
    <div class="search-input-wrap">
      <span class="search-icon">&#128269;</span>
      <input
        id="filter"
        type="search"
        placeholder="Filter by path, method, or file..."
        spellcheck="false"
        autocomplete="off"
      />
      <button id="clear" title="Clear filter" aria-label="Clear filter">&#10005;</button>
    </div>
  </div>
  <div id="count" class="hidden"></div>
  <div id="list" class="list"></div>
  <div id="status" class="status hidden"></div>

  <script>
    const vscode = acquireVsCodeApi();
    const filterInput = document.getElementById("filter");
    const clearButton = document.getElementById("clear");
    const countEl = document.getElementById("count");
    const listEl = document.getElementById("list");
    const statusEl = document.getElementById("status");

    let allEndpoints = [];

    function formatCount(shown, total) {
      const noun = total === 1 ? "endpoint" : "endpoints";
      if (shown === total) {
        return total + " " + noun;
      }
      return shown + " of " + total + " " + noun;
    }

    function updateCount(shown, total) {
      if (total <= 0) {
        countEl.classList.add("hidden");
        countEl.textContent = "";
        return;
      }

      countEl.textContent = formatCount(shown, total);
      countEl.classList.remove("hidden");
    }

    function setFilterActive(active) {
      vscode.postMessage({ type: "filterChanged", active });
      clearButton.classList.toggle("visible", active);
    }

    function render() {
      const query = filterInput.value.trim().toLowerCase();
      setFilterActive(query.length > 0);

      const filtered = query
        ? allEndpoints.filter((item) => item.searchText.toLowerCase().includes(query))
        : allEndpoints;

      listEl.innerHTML = "";
      statusEl.classList.add("hidden");
      updateCount(filtered.length, allEndpoints.length);

      if (filtered.length === 0) {
        statusEl.textContent = query
          ? 'No endpoints match "' + filterInput.value.trim() + '"'
          : "No API endpoints found";
        statusEl.classList.remove("hidden");
        return;
      }

      for (const item of filtered) {
        const row = document.createElement("div");
        row.className = "item";
        row.tabIndex = 0;
        row.innerHTML =
          '<span class="icon">&#127760;</span>' +
          '<span class="label"></span>' +
          '<span class="description"></span>';

        row.querySelector(".label").textContent = item.label;
        row.querySelector(".description").textContent = item.description;

        row.addEventListener("click", () => {
          vscode.postMessage({ type: "open", index: item.index });
        });

        row.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            vscode.postMessage({ type: "open", index: item.index });
          }
        });

        listEl.appendChild(row);
      }
    }

    filterInput.addEventListener("input", render);

    clearButton.addEventListener("click", () => {
      filterInput.value = "";
      render();
      filterInput.focus();
    });

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (!message || message.type !== "update") {
        if (message?.type === "clearSearch") {
          filterInput.value = "";
          render();
        }
        return;
      }

      if (typeof message.query === "string" && message.query !== filterInput.value) {
        filterInput.value = message.query;
        clearButton.classList.toggle("visible", message.query.trim().length > 0);
      }

      if (message.status === "loading") {
        allEndpoints = [];
        listEl.innerHTML = "";
        countEl.classList.add("hidden");
        statusEl.textContent = "Scanning ASP.NET Core project...";
        statusEl.classList.remove("hidden");
        return;
      }

      if (message.status === "message") {
        allEndpoints = [];
        listEl.innerHTML = "";
        countEl.classList.add("hidden");
        statusEl.textContent = message.message || "No API endpoints found";
        statusEl.classList.remove("hidden");
        return;
      }

      allEndpoints = message.endpoints || [];
      render();
    });
  </script>
</body>
</html>`;
  }
}
