import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import type { ApiCall } from "./types";

const execFileAsync = promisify(execFile);

interface DotNetEndpointDto {
  filePath: string;
  line: number;
  column: number;
  method: string;
  url: string;
  snippet: string;
}

interface DotNetScanResponse {
  endpoints?: DotNetEndpointDto[];
  analyzer?: string;
  warning?: string;
}

export interface DotNetScanResult {
  calls: ApiCall[];
  analyzer: string;
  warning?: string;
}

function getAnalyzerDllPath(extensionPath: string): string {
  return path.join(extensionPath, "analyzer", "publish", "DEndpoint.Analyzer.dll");
}

export function isDotNetAnalyzerAvailable(extensionPath: string): boolean {
  return fs.existsSync(getAnalyzerDllPath(extensionPath));
}

export async function scanWithDotNetAnalyzer(
  workspaceRoot: string,
  extensionPath: string,
): Promise<DotNetScanResult | undefined> {
  const analyzerDll = getAnalyzerDllPath(extensionPath);
  if (!fs.existsSync(analyzerDll)) {
    return undefined;
  }

  try {
    const { stdout } = await execFileAsync(
      "dotnet",
      ["exec", analyzerDll, workspaceRoot],
      {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000,
        windowsHide: true,
      },
    );

    const parsed = JSON.parse(stdout) as DotNetScanResponse;
    if (!parsed.endpoints) {
      return undefined;
    }

    const calls: ApiCall[] = parsed.endpoints.map((endpoint) => ({
      filePath: endpoint.filePath,
      line: endpoint.line,
      column: endpoint.column,
      method: endpoint.method.toUpperCase(),
      url: endpoint.url,
      snippet: endpoint.snippet,
    }));

    return {
      calls,
      analyzer: parsed.analyzer ?? "roslyn",
      warning: parsed.warning,
    };
  } catch {
    return undefined;
  }
}
