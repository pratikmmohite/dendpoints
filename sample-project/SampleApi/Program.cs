using SampleApi.Routes;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();

var app = builder.Build();

app.MapGet(ApiRoutes.Health, () => Results.Ok("healthy"));
app.MapPost(ApiRoutes.Items, () => Results.Created());

var users = app.MapGroup(ApiRoutes.UsersBase);
users.MapGet("/", () => Results.Ok(Array.Empty<object>()));
users.MapGet("/{id:int}", (int id) => Results.Ok(new { id }));
users.MapPost("/", () => Results.Created());

app.MapControllers();
app.Run();
