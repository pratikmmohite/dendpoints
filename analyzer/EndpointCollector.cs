using System.Text;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Builder;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace DEndpoint.Analyzer;

internal sealed class EndpointCollector
{
    private static readonly HashSet<string> IgnoredDirectories = new(StringComparer.OrdinalIgnoreCase)
    {
        "bin", "obj", "node_modules", ".git", "out", "dist", "build", "coverage", "vendor",
    };

    private static readonly string[] HttpMethodAttributeNames =
    {
        "HttpGetAttribute",
        "HttpPostAttribute",
        "HttpPutAttribute",
        "HttpPatchAttribute",
        "HttpDeleteAttribute",
        "HttpHeadAttribute",
        "HttpOptionsAttribute",
    };

    private static readonly string[] MapMethodNames =
    {
        "MapGet", "MapPost", "MapPut", "MapPatch", "MapDelete", "MapHead", "MapOptions",
    };

    private readonly string _workspaceRoot;
    private readonly List<EndpointDto> _endpoints = new();
    private readonly Dictionary<string, string> _mapGroupPrefixes = new(StringComparer.Ordinal);

    public string? Warning { get; private set; }

    public EndpointCollector(string workspaceRoot)
    {
        _workspaceRoot = Path.GetFullPath(workspaceRoot);
    }

    public IReadOnlyList<EndpointDto> Collect()
    {
        var projectRoots = FindAspNetCoreProjectRoots(_workspaceRoot);
        if (projectRoots.Count == 0)
        {
            Warning = "No ASP.NET Core .csproj found in workspace";
            return _endpoints;
        }

        var sourceFiles = new List<string>();
        foreach (var projectRoot in projectRoots)
        {
            CollectSourceFiles(projectRoot, sourceFiles);
        }

        if (sourceFiles.Count == 0)
        {
            return _endpoints;
        }

        var trees = sourceFiles
            .Select(file => CSharpSyntaxTree.ParseText(File.ReadAllText(file), path: file))
            .ToArray();

        var references = MetadataReferenceProvider.GetReferences();
        var compilation = CSharpCompilation.Create(
            "DEndpointAnalysis",
            trees,
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        foreach (var diagnostic in compilation.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error))
        {
            Warning ??= "Compilation has errors; some endpoints may be missing.";
        }

        foreach (var tree in trees)
        {
            var semanticModel = compilation.GetSemanticModel(tree);
            CollectMapGroups(tree.GetRoot(), semanticModel);
            CollectMinimalApis(tree.GetRoot(), semanticModel, tree.FilePath);
            CollectControllerEndpoints(tree.GetRoot(), semanticModel, tree.FilePath);
        }

        return _endpoints
            .OrderBy(endpoint => endpoint.FilePath, StringComparer.OrdinalIgnoreCase)
            .ThenBy(endpoint => endpoint.Line)
            .ToList();
    }

    private static HashSet<string> FindAspNetCoreProjectRoots(string root)
    {
        var projectRoots = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var csproj in Directory.EnumerateFiles(root, "*.csproj", SearchOption.AllDirectories))
        {
            if (IsUnderIgnoredDirectory(csproj))
            {
                continue;
            }

            var content = File.ReadAllText(csproj);
            if (content.Contains("Microsoft.NET.Sdk.Web", StringComparison.OrdinalIgnoreCase) ||
                content.Contains("Microsoft.AspNetCore", StringComparison.OrdinalIgnoreCase))
            {
                projectRoots.Add(Path.GetDirectoryName(csproj)!);
            }
        }

        return projectRoots;
    }

    private static void CollectSourceFiles(string dir, List<string> results)
    {
        foreach (var entry in Directory.EnumerateFileSystemEntries(dir))
        {
            var name = Path.GetFileName(entry);
            if (name.StartsWith('.'))
            {
                continue;
            }

            if (Directory.Exists(entry))
            {
                if (!IgnoredDirectories.Contains(name))
                {
                    CollectSourceFiles(entry, results);
                }

                continue;
            }

            if (entry.EndsWith(".cs", StringComparison.OrdinalIgnoreCase))
            {
                results.Add(entry);
            }
        }
    }

    private static bool IsUnderIgnoredDirectory(string filePath)
    {
        var parts = filePath.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        return parts.Any(IgnoredDirectories.Contains);
    }

    private void CollectMapGroups(SyntaxNode root, SemanticModel semanticModel)
    {
        foreach (var declarator in root.DescendantNodes().OfType<VariableDeclaratorSyntax>())
        {
            if (declarator.Initializer?.Value is not InvocationExpressionSyntax invocation)
            {
                continue;
            }

            var methodName = GetMethodName(invocation);
            if (!string.Equals(methodName, "MapGroup", StringComparison.Ordinal))
            {
                continue;
            }

            var route = GetRouteFromExpression(
                invocation.ArgumentList.Arguments.FirstOrDefault()?.Expression,
                semanticModel);

            if (route is null || string.IsNullOrWhiteSpace(declarator.Identifier.Text))
            {
                continue;
            }

            _mapGroupPrefixes[declarator.Identifier.Text] = NormalizeRoute(route);
        }
    }

    private void CollectMinimalApis(SyntaxNode root, SemanticModel semanticModel, string? filePath)
    {
        if (string.IsNullOrWhiteSpace(filePath))
        {
            return;
        }

        foreach (var invocation in root.DescendantNodes().OfType<InvocationExpressionSyntax>())
        {
            if (invocation.Expression is not MemberAccessExpressionSyntax memberAccess)
            {
                continue;
            }

            var methodName = memberAccess.Name.Identifier.Text;
            if (!MapMethodNames.Contains(methodName))
            {
                continue;
            }

            var httpMethod = methodName["Map".Length..].ToUpperInvariant();
            var routeExpression = invocation.ArgumentList.Arguments.FirstOrDefault()?.Expression;
            var route = GetRouteFromExpression(routeExpression, semanticModel);
            if (route is null)
            {
                continue;
            }

            route = NormalizeRoute(route);
            if (memberAccess.Expression is IdentifierNameSyntax identifier &&
                _mapGroupPrefixes.TryGetValue(identifier.Identifier.Text, out var prefix))
            {
                route = JoinRoutes(prefix, route);
            }

            AddEndpoint(filePath, routeExpression ?? invocation, httpMethod, route);
        }
    }

    private void CollectControllerEndpoints(SyntaxNode root, SemanticModel semanticModel, string? filePath)
    {
        if (string.IsNullOrWhiteSpace(filePath))
        {
            return;
        }

        foreach (var classDeclaration in root.DescendantNodes().OfType<ClassDeclarationSyntax>())
        {
            var classSymbol = semanticModel.GetDeclaredSymbol(classDeclaration);
            if (classSymbol is null || !InheritsFromControllerBase(classSymbol))
            {
                continue;
            }

            var classRoute = GetRouteTemplate(classSymbol, semanticModel);
            foreach (var methodDeclaration in classDeclaration.Members.OfType<MethodDeclarationSyntax>())
            {
                var methodSymbol = semanticModel.GetDeclaredSymbol(methodDeclaration);
                if (methodSymbol is null)
                {
                    continue;
                }

                var methodRoute = GetRouteTemplate(methodSymbol, semanticModel);
                foreach (var attribute in methodSymbol.GetAttributes())
                {
                    if (!TryGetHttpMethod(attribute, out var httpMethod))
                    {
                        continue;
                    }

                    var attributeRoute = GetRouteTemplateFromHttpAttribute(attribute, semanticModel);
                    var combined = JoinRoutes(
                        classRoute,
                        attributeRoute ?? methodRoute);

                    combined = ApplyRouteTokens(
                        combined,
                        classSymbol.Name,
                        methodSymbol.Name);

                    var attributeSyntax = methodDeclaration.AttributeLists
                        .SelectMany(list => list.Attributes)
                        .FirstOrDefault(attr =>
                            string.Equals(
                                semanticModel.GetTypeInfo(attr).Type?.Name,
                                attribute.AttributeClass?.Name,
                                StringComparison.Ordinal));

                    AddEndpoint(
                        filePath,
                        (SyntaxNode?)attributeSyntax ?? methodDeclaration,
                        httpMethod,
                        combined);
                }
            }
        }
    }

    private static string? GetRouteTemplateFromHttpAttribute(
        AttributeData attribute,
        SemanticModel semanticModel)
    {
        if (attribute.ConstructorArguments.Length == 0)
        {
            return null;
        }

        return GetRouteFromTypedConstant(attribute.ConstructorArguments[0], semanticModel);
    }

    private static bool InheritsFromControllerBase(INamedTypeSymbol classSymbol)
    {
        for (var baseType = classSymbol.BaseType; baseType is not null; baseType = baseType.BaseType)
        {
            if (string.Equals(baseType.Name, nameof(ControllerBase), StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    private static string? GetRouteTemplate(ISymbol symbol, SemanticModel semanticModel)
    {
        foreach (var attribute in symbol.GetAttributes())
        {
            var route = GetRouteTemplateFromAttribute(attribute, semanticModel);
            if (route is not null)
            {
                return route;
            }
        }

        return null;
    }

    private static string? GetRouteTemplateFromAttribute(AttributeData attribute, SemanticModel semanticModel)
    {
        if (attribute.AttributeClass?.Name is not "RouteAttribute" and not "Route")
        {
            return null;
        }

        if (attribute.ConstructorArguments.Length == 0)
        {
            return null;
        }

        return GetRouteFromTypedConstant(attribute.ConstructorArguments[0], semanticModel);
    }

    private static bool TryGetHttpMethod(AttributeData attribute, out string httpMethod)
    {
        httpMethod = string.Empty;
        var attributeName = attribute.AttributeClass?.Name;
        if (attributeName is null || !HttpMethodAttributeNames.Contains(attributeName))
        {
            return false;
        }

        httpMethod = attributeName
            .Replace("Attribute", string.Empty, StringComparison.Ordinal)
            ["Http".Length..]
            .ToUpperInvariant();
        return true;
    }

    private static string? GetRouteFromExpression(ExpressionSyntax? expression, SemanticModel semanticModel)
    {
        if (expression is null)
        {
            return null;
        }

        var constant = semanticModel.GetConstantValue(expression);
        if (constant.HasValue && constant.Value is string literal)
        {
            return literal;
        }

        var symbol = semanticModel.GetSymbolInfo(expression).Symbol;
        if (symbol is IFieldSymbol { HasConstantValue: true } field)
        {
            return field.ConstantValue as string;
        }

        if (symbol is ILocalSymbol { HasConstantValue: true } local)
        {
            return local.ConstantValue as string;
        }

        if (expression is IdentifierNameSyntax or MemberAccessExpressionSyntax)
        {
            return $"{{{expression.ToString()}}}";
        }

        return null;
    }

    private static string? GetRouteFromTypedConstant(TypedConstant constant, SemanticModel semanticModel)
    {
        if (constant.Kind == TypedConstantKind.Primitive && constant.Value is string literal)
        {
            return literal;
        }

        return constant.Value?.ToString();
    }

    private static string? GetMethodName(InvocationExpressionSyntax invocation)
    {
        return invocation.Expression switch
        {
            MemberAccessExpressionSyntax memberAccess => memberAccess.Name.Identifier.Text,
            IdentifierNameSyntax identifier => identifier.Identifier.Text,
            _ => null,
        };
    }

    private static string NormalizeRoute(string route)
    {
        var trimmed = route.Trim();
        if (trimmed.Length == 0)
        {
            return "/";
        }

        return trimmed.StartsWith('/') ? trimmed : $"/{trimmed}";
    }

    private static string JoinRoutes(string? baseRoute, string? methodRoute)
    {
        var baseValue = NormalizeRoute(baseRoute ?? string.Empty);
        var suffix = methodRoute?.Trim() ?? string.Empty;

        if (suffix.Length == 0)
        {
            return baseValue == "/" ? "/" : baseValue.TrimEnd('/');
        }

        var normalizedSuffix = NormalizeRoute(suffix);
        if (baseValue == "/" || baseValue.Length == 0)
        {
            return normalizedSuffix;
        }

        return $"{baseValue.TrimEnd('/')}{normalizedSuffix}";
    }

    private static string ApplyRouteTokens(string route, string className, string actionName)
    {
        var controllerToken = className.EndsWith("Controller", StringComparison.Ordinal)
            ? className[..^"Controller".Length]
            : className;

        return route
            .Replace("[controller]", controllerToken, StringComparison.OrdinalIgnoreCase)
            .Replace("[action]", actionName, StringComparison.OrdinalIgnoreCase);
    }

    private void AddEndpoint(string filePath, SyntaxNode syntaxNode, string method, string url)
    {
        var lineSpan = syntaxNode.GetLocation().GetLineSpan();
        var line = Math.Max(lineSpan.StartLinePosition.Line, 0);
        var column = Math.Max(lineSpan.StartLinePosition.Character, 0);
        var lines = File.ReadAllLines(filePath);
        var snippet = line < lines.Length ? lines[line].Trim() : syntaxNode.ToString().Trim();
        if (snippet.Length > 120)
        {
            snippet = snippet[..117] + "...";
        }

        _endpoints.Add(new EndpointDto(filePath, line, column, method, url, snippet));
    }
}

internal static class MetadataReferenceProvider
{
    public static IReadOnlyList<MetadataReference> GetReferences()
    {
        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            typeof(object).Assembly.Location,
            typeof(ControllerBase).Assembly.Location,
            typeof(WebApplication).Assembly.Location,
        };

        var trusted = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (!string.IsNullOrWhiteSpace(trusted))
        {
            foreach (var assemblyPath in trusted.Split(Path.PathSeparator))
            {
                if (assemblyPath.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
                {
                    paths.Add(assemblyPath);
                }
            }
        }

        return paths
            .Where(File.Exists)
            .Select(assemblyPath => MetadataReference.CreateFromFile(assemblyPath))
            .ToList();
    }
}
