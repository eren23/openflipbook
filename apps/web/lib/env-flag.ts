// Boolean env-flag parse, shared by the API routes. The truthy set and
// default-false behaviour match the spelling that used to be inlined at each
// call site (`["1","true","yes"].includes((process.env.X ?? "").toLowerCase())`
// and its `flag === "1" || …` twin). Anything outside the set — unset, empty,
// "0", "off", "no" — is false.
export const envFlag = (name: string): boolean =>
  ["1", "true", "yes"].includes((process.env[name] ?? "").toLowerCase());
