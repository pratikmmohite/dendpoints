const NAMESPACE_REGEX = /^\s*namespace\s+([\w.]+)\s*;/m;

export type RouteConstantIndex = Map<string, string>;

function registerConstant(
  index: RouteConstantIndex,
  namespace: string | undefined,
  className: string | undefined,
  name: string,
  value: string,
): void {
  index.set(name, value);

  if (className) {
    index.set(`${className}.${name}`, value);
  }

  if (namespace && className) {
    index.set(`${namespace}.${className}.${name}`, value);
  }
}

export function buildRouteConstantIndex(
  fileContents: Iterable<string>,
): RouteConstantIndex {
  const index: RouteConstantIndex = new Map();

  for (const content of fileContents) {
    const namespace = content.match(NAMESPACE_REGEX)?.[1];
    let currentClass: string | undefined;

    for (const line of content.split("\n")) {
      const classMatch = line.match(
        /(?:public|private|internal|protected)?\s*(?:static\s+)?(?:partial\s+)?class\s+(\w+)\b/,
      );
      if (classMatch?.[1]) {
        currentClass = classMatch[1];
      }

      const constMatch = line.match(
        /(?:public|private|internal|protected)?\s*(?:static\s+)?const\s+string\s+(\w+)\s*=\s*["']([^"']+)["']/,
      );
      if (constMatch?.[1] && constMatch[2]) {
        registerConstant(index, namespace, currentClass, constMatch[1], constMatch[2]);
      }

      const readonlyMatch = line.match(
        /(?:public|private|internal|protected)?\s*static\s+readonly\s+string\s+(\w+)\s*=\s*["']([^"']+)["']/,
      );
      if (readonlyMatch?.[1] && readonlyMatch[2]) {
        registerConstant(
          index,
          namespace,
          currentClass,
          readonlyMatch[1],
          readonlyMatch[2],
        );
      }
    }
  }

  return index;
}

export function resolveRouteReference(
  reference: string,
  index: RouteConstantIndex,
): string | undefined {
  const trimmed = reference.trim();
  if (!trimmed) {
    return undefined;
  }

  if (index.has(trimmed)) {
    return index.get(trimmed);
  }

  const parts = trimmed.split(".");
  if (parts.length >= 2) {
    const classMember = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
    if (index.has(classMember)) {
      return index.get(classMember);
    }
  }

  const simpleName = parts[parts.length - 1];
  if (simpleName && index.has(simpleName)) {
    return index.get(simpleName);
  }

  return undefined;
}

export function resolveRouteValue(
  literal: string | undefined,
  reference: string | undefined,
  index: RouteConstantIndex,
): string | undefined {
  if (literal !== undefined) {
    return literal;
  }

  if (!reference) {
    return undefined;
  }

  return resolveRouteReference(reference, index);
}

export function displayRouteValue(
  literal: string | undefined,
  reference: string | undefined,
  index: RouteConstantIndex,
): string {
  const resolved = resolveRouteValue(literal, reference, index);
  if (resolved !== undefined) {
    return resolved;
  }

  if (reference) {
    return `{${reference}}`;
  }

  return "";
}
