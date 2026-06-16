import * as vscode from "vscode";
import { ApiCallsTreeProvider, openApiCall } from "./apiTreeProvider";

let treeProvider: ApiCallsTreeProvider | undefined;

function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }

  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    const match = folders.find((folder) =>
      activeEditor.document.uri.fsPath.startsWith(folder.uri.fsPath),
    );
    if (match) {
      return match;
    }
  }

  return folders[0];
}

export function activate(context: vscode.ExtensionContext): void {
  const getScanOptions = () => ({
    extensionPath: context.extensionPath,
    useRoslynAnalyzer: vscode.workspace
      .getConfiguration("dendpoint")
      .get<boolean>("useRoslynAnalyzer", true),
  });

  treeProvider = new ApiCallsTreeProvider(getWorkspaceFolder, getScanOptions);

  const treeView = vscode.window.createTreeView("dendpoint.apiCalls", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  context.subscriptions.push(
    treeView,
    vscode.commands.registerCommand("dendpoint.refresh", () => {
      treeProvider?.refresh();
    }),
    vscode.commands.registerCommand("dendpoint.search", async () => {
      if (!treeProvider) {
        return;
      }

      const query = await vscode.window.showInputBox({
        placeHolder: "Filter by path, method, or file...",
        prompt: "Search API endpoints",
        value: treeProvider.filterQuery,
      });

      if (query === undefined) {
        return;
      }

      treeProvider.setSearchQuery(query);
    }),
    vscode.commands.registerCommand("dendpoint.clearSearch", () => {
      treeProvider?.clearSearch();
    }),
    vscode.commands.registerCommand("dendpoint.openApiCall", (apiCall) => {
      void openApiCall(apiCall);
    }),
    vscode.commands.registerCommand("dendpoint.showExplorer", () => {
      void vscode.commands.executeCommand("workbench.view.extension.dendpoint");
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      treeProvider?.refresh();
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.uri.fsPath.endsWith(".cs")) {
        treeProvider?.refresh();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("dendpoint.useRoslynAnalyzer")) {
        treeProvider?.refresh();
      }
    }),
  );

  void treeProvider.loadApiCalls();
}

export function deactivate(): void {
  treeProvider = undefined;
}
