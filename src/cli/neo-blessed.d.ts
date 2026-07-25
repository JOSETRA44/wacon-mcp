// neo-blessed ships no type declarations. ultra.ts casts the import to its own
// minimal `Blessed` shape, so all we need is to silence the missing-types error.
declare module "neo-blessed";
