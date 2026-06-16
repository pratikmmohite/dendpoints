using System.Text.Json;

namespace DEndpoint.Analyzer;

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    public static int Main(string[] args)
    {
        if (args.Length == 0 || string.IsNullOrWhiteSpace(args[0]))
        {
            Console.Error.WriteLine("Usage: DEndpoint.Analyzer <workspace-root>");
            return 1;
        }

        try
        {
            var collector = new EndpointCollector(args[0]);
            var endpoints = collector.Collect();
            var response = new ScanResponse(endpoints, "roslyn", collector.Warning);
            Console.WriteLine(JsonSerializer.Serialize(response, JsonOptions));
            return 0;
        }
        catch (Exception ex)
        {
            var response = new ScanResponse(
                Array.Empty<EndpointDto>(),
                "roslyn",
                ex.Message);
            Console.WriteLine(JsonSerializer.Serialize(response, JsonOptions));
            return 2;
        }
    }
}
