using Microsoft.AspNetCore.Mvc;
using SampleApi.Routes;

namespace SampleApi.Controllers;

[ApiController]
[Route("api/[controller]")]
public class ProductsController : ControllerBase
{
    [HttpGet]
    public IActionResult GetAll() => Ok();

    [HttpGet("{id:int}")]
    public IActionResult GetById(int id) => Ok();

    [HttpPost]
    public IActionResult Create() => Created();

    [HttpPut("{id:int}")]
    public IActionResult Update(int id) => NoContent();

    [HttpDelete("{id:int}")]
    public IActionResult Delete(int id) => NoContent();
}

[Route(ApiRoutes.OrdersBase)]
public class OrdersController : ControllerBase
{
    [HttpGet("")]
    public IActionResult List() => Ok();

    [Route(ApiRoutes.OrderSummary)]
    [HttpGet]
    public IActionResult Summary() => Ok();
}

[Route(ApiRoutes.Items)]
public class ItemsController : ControllerBase
{
    [HttpGet]
    public IActionResult GetAll() => Ok();
}
