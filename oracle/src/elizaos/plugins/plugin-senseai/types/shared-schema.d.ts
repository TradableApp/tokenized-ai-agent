// Type stub for @tradableapp/sense-ai-shared-schema.
//
// The Brain is a PATH dependency, so this package resolves through a symlink to raw .ts
// sources living OUTSIDE node_modules — `exclude` does not reach them and `skipLibCheck` only
// covers .d.ts. Typechecking them would require adding `drizzle-orm` to this plugin, which the
// Brain's own CLAUDE.md warns against explicitly: a second copy "would shadow the host copy and
// split drizzle into two identities" — a real hazard inside the TEE bundle.
//
// This plugin never touches the schema directly; it only calls the Brain's formatters and
// engine methods. Stubbing the module keeps THIS plugin's source fully typechecked (the tsc
// step doubles as its typecheck) without dragging drizzle in for types nobody here uses.
declare module "@tradableapp/sense-ai-shared-schema" {
  const schema: Record<string, unknown>;
  export = schema;
}
