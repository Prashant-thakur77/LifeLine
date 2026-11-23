// The small part of JSON Schema the tools use, and a checker for it. Arguments come from a
// model that may have read anything, so nothing outside the schema gets through.

export type Prop = {
  type: "string" | "number" | "integer" | "boolean";
  description: string;
  pattern?: string;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
};
export type InputSchema = { type: "object"; properties: Record<string, Prop>; required?: string[]; additionalProperties: false };
export type Args = Record<string, string | number | boolean | undefined>;

/** What's wrong with these arguments, or null. */
export function problemWith(schema: InputSchema, args: unknown): string | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return "arguments must be an object";
  const given = args as Record<string, unknown>;
  for (const name of schema.required ?? []) if (given[name] === undefined) return `${name} is required`;
  for (const [name, value] of Object.entries(given)) {
    const prop = Object.hasOwn(schema.properties, name) ? schema.properties[name] : undefined;
    if (prop === undefined) return "there is an argument this tool doesn't take";
    if (value === undefined) continue;
    const kind = prop.type === "integer" || prop.type === "number" ? "number" : prop.type;
    if (typeof value !== kind) return `${name} must be a ${kind}`;
    if (typeof value === "number") {
      if (!Number.isFinite(value) || (prop.type === "integer" && !Number.isInteger(value))) return `${name} must be a ${prop.type === "integer" ? "whole" : "finite"} number`;
      if (prop.minimum !== undefined && value < prop.minimum) return `${name} must be at least ${prop.minimum}`;
      if (prop.maximum !== undefined && value > prop.maximum) return `${name} must be at most ${prop.maximum}`;
    }
    if (typeof value === "string") {
      if (value.length > 128) return `${name} is too long`;
      if (prop.enum && !prop.enum.includes(value)) return `${name} must be one of ${prop.enum.join(", ")}`;
      if (prop.pattern && !new RegExp(prop.pattern).test(value)) return `${name} isn't in the right form`;
    }
  }
  return null;
}
