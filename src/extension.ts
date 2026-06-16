import * as vscode from "vscode";
import { EndpointPanelProvider } from "./endpointPanelProvider";

let panelProvider: EndpointPanelProvider | undefined;

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

  panelProvider = new EndpointPanelProvider(
    context.extensionUri,
    getWorkspaceFolder,
    getScanOptions,
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      EndpointPanelProvider.viewType,
      panelProvider,
    ),
    vscode.commands.registerCommand("dendpoint.refresh", () => {
      void panelProvider?.refresh();
    }),
    vscode.commands.registerCommand("dendpoint.clearSearch", () => {
      panelProvider?.clearSearch();
    }),
    vscode.commands.registerCommand("dendpoint.showExplorer", () => {
      void vscode.commands.executeCommand("workbench.view.extension.dendpoint");
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void panelProvider?.refresh();
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.uri.fsPath.endsWith(".cs")) {
        void panelProvider?.refresh();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("dendpoint.useRoslynAnalyzer")) {
        void panelProvider?.refresh();
      }
    }),
  );
}

export function deactivate(): void {
  panelProvider = undefined;
}
