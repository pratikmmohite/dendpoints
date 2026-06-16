namespace DEndpoint.Analyzer;

public sealed record EndpointDto(
    string FilePath,
    int Line,
    int Column,
    string Method,
    string Url,
    string Snippet);

public sealed record ScanResponse(
    IReadOnlyList<EndpointDto> Endpoints,
    string? Analyzer,
    string? Warning);
