# DEndpoint

Discover API endpoints in **ASP.NET Core** C# projects directly inside VS Code or Cursor.

DEndpoint scans your workspace, finds controller actions and minimal API routes, and lists them in a sidebar tree. Click any endpoint to jump to its definition in source code.

## Requirements

- VS Code or Cursor **1.85+**
- A workspace folder that contains at least one **ASP.NET Core** `.csproj` (for example `Microsoft.NET.Sdk.Web`)

## Installation

### From a VSIX package

1. Build the extension (see [Development](#development)) or use a pre-built `dendpoint-0.2.0.vsix`.
2. In VS Code / Cursor, open the **Extensions** view.
3. Click the **...** menu → **Install from VSIX...**
4. Select the `.vsix` file.

Or from a terminal:

```bash
code --install-extension dendpoint-0.2.0.vsix
```

### From source (Extension Development Host)

```bash
npm install
npm run build
```

Press **F5** in VS Code to launch an Extension Development Host with the extension loaded.

## How to use

### 1. Open an ASP.NET Core project

Open a folder (or solution root) that contains your Web API `.csproj` files.

```
MyApi/
├── MyApi.csproj
├── Program.cs
└── Controllers/
    └── ProductsController.cs
```

The extension activates automatically when a `.csproj` is present in the workspace.

### 2. Open Endpoint Explorer

Click the **Endpoint Explorer** icon in the **Activity Bar** (left sidebar), alongside Explorer, Search, Source Control, and similar views.

You can also open it from the Command Palette (**Cmd+Shift+P** / **Ctrl+Shift+P**) and run **Endpoint Explorer: Show**.

If you do not see the icon, ensure the extension is installed and the workspace contains an ASP.NET Core project.

### 3. Browse endpoints

The tree is grouped by C# file. Each file shows a count of endpoints found inside it.

Expand a file to see individual routes listed as **Method urlpath**:

```
GET /api/Products
GET /api/Products/{id:int}
POST /api/Products
PUT /api/Products/{id:int}
DELETE /api/Products/{id:int}
GET /health
POST /api/items
GET /api/users/{id:int}
```

Each item shows:

- **Method urlpath** — for example `GET /api/Products`
- **Source file and line** on the right — for example `Controllers/ProductsController.cs · L12`

### 4. Jump to source

Click an endpoint in the tree. The editor opens the file and places the cursor on the attribute or `Map*` call that defines that route.

### 5. Refresh the list

Endpoints are rescanned when you:

- Save a `.cs` file
- Add or remove workspace folders

To scan manually, click the **Refresh** icon in the **Endpoint Explorer** view title bar.

## What gets detected

DEndpoint scans `.cs` files inside ASP.NET Core project folders and ignores `bin/`, `obj/`, `node_modules/`, and other build/output directories.

### Controller-based APIs

| Pattern | Example |
|--------|---------|
| Class route | `[Route("api/[controller]")]` |
| HTTP verbs | `[HttpGet]`, `[HttpPost("{id}")]` |
| Method route | `[Route("summary")]` combined with `[HttpGet]` |
| Route tokens | `[controller]`, `[action]` resolved from class/method names |

Example:

```csharp
[ApiController]
[Route("api/[controller]")]
public class ProductsController : ControllerBase
{
    [HttpGet("{id:int}")]
    public IActionResult GetById(int id) => Ok();
}
```

Detected as: `GET /api/Products/{id:int}`

### Minimal APIs

| Pattern | Example |
|--------|---------|
| Direct maps | `app.MapGet("/health", ...)` |
| Route groups | `var users = app.MapGroup("/api/users");` |
| Group maps | `users.MapGet("/{id:int}", ...)` → `/api/users/{id:int}` |

Example:

```csharp
var users = app.MapGroup("/api/users");
users.MapGet("/{id:int}", (int id) => Results.Ok(new { id }));
```

Detected as: `GET /api/users/{id:int}`

### Route constants

DEndpoint resolves `const string` and `static readonly string` route constants defined in your project:

```csharp
public static class ApiRoutes
{
    public const string Users = "/api/users";
}

[HttpGet(ApiRoutes.Users)]
public IActionResult List() => Ok();

app.MapGet(ApiRoutes.Health, () => Results.Ok());
var users = app.MapGroup(ApiRoutes.UsersBase);
```

Supported references:

- `ApiRoutes.Users`
- `SampleApi.Routes.ApiRoutes.Users` (namespace-qualified)

If a constant cannot be resolved (for example computed paths), the explorer shows the reference name: `GET {ApiRoutes.UnknownRoute}`.

### Roslyn static analysis (recommended)

When **`.NET SDK`** is installed, DEndpoint uses a bundled **Roslyn** analyzer (`Microsoft.CodeAnalysis.CSharp`) for semantic endpoint discovery. This is more accurate than regex scanning because it:

- Resolves **`const` field values** across files (for example `ApiRoutes.Users` → `/api/users`)
- Reads **controller attributes** via symbols (`HttpGet`, `Route`, `ControllerBase`)
- Analyzes **minimal API** `MapGet` / `MapGroup` calls with semantic models

Toggle in settings: **`dendpoint.useRoslynAnalyzer`** (default: `true`).

**Assembly reflection** (loading compiled `.dll` files) is *not* used because it requires a successful build, misses many minimal API routes in source, and is runtime-oriented rather than source-oriented. Roslyn analyzes `.cs` files directly.

If Roslyn is disabled or unavailable, the extension falls back to regex scanning.

## Try the sample project

A small sample API is included for testing:

```bash
# Open this folder in VS Code / Cursor
sample-project/SampleApi/
```

You should see endpoints from `Program.cs` and `Controllers/ProductsController.cs` in the sidebar.

## Troubleshooting

| Message | Meaning |
|--------|---------|
| **No ASP.NET Core .csproj found in workspace** | Open a folder that contains a Web SDK or AspNetCore project file. |
| **No API endpoints found** | No matching routes were found in `.cs` files. Check that controllers or minimal APIs use standard attributes / `Map*` calls. |
| **Open an ASP.NET Core folder to scan endpoints** | No workspace folder is open. Use **File → Open Folder**. |

### Endpoints missing?

DEndpoint uses pattern-based scanning (not the Roslyn compiler). Some advanced routing setups may not appear, for example:

- Routes defined only via conventions with no attributes
- Dynamically built routes at runtime
- Constants built from expressions (for example `Base + "/users"`)
- External route configuration outside `.cs` files

If an endpoint is missing, ensure the route is declared with `[Http*]` / `[Route]` attributes or `MapGet` / `MapPost` style calls with string literals.

## Development

```bash
npm install
npm run build          # publishes Roslyn analyzer + compiles extension
npm run package        # creates .vsix
```

Requires **.NET 8 SDK** to build the analyzer. End users need **.NET runtime/SDK** on `PATH` for Roslyn mode (`dotnet exec ...`).

### Project layout

```
analyzer/               # .NET Roslyn endpoint analyzer
  DEndpoint.Analyzer.csproj
  EndpointCollector.cs
src/
  dotnetAnalyzer.ts     # spawns bundled analyzer via dotnet exec
  apiScanner.ts         # Roslyn-first, regex fallback
  extension.ts
  apiTreeProvider.ts
```
